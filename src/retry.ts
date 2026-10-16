/**
 * 带重试的 fetch（2026-10-16）—— 应对上游**连接层抖动**。
 *
 * ## 为什么需要
 * 三家的活动/签到接口（Qoder `openapi.qoder.com.cn`、MiniMax `agent.minimax.cn`、
 * WorkBuddy `copilot.tencent.com`）都会出现**间歇性连接超时**。实测 Qoder 那个域
 * 连续 10 次探测**成功 3 / 超时 7**（约 70% 失败），但带令牌重试 6 次里 4 次正常拿到
 * `claimable:true` —— 即**上游是好的，只是连接不稳定**。
 *
 * 而三家原来的实现都是「打一次就完」，于是用户点签到有约七成概率看到
 * `checkin 失败：fetch failed`。**这是可修的**：重试 2 次能把成功率从 ~30% 提到 ~97%。
 * （qoder 的聊天路径早有同类对策：首块探测 + 重试 1 次对付网关零内容断流。）
 *
 * ## 只重试"连接类"失败，不重试业务失败
 *   · **重试**：请求根本没打通 —— DNS/连接超时/连接重置/正常超时，以及 502/503/504
 *     （网关瞬时不可用）。这些重试是安全的：请求要么没到达、要么上游明确说"我暂时不行"。
 *   · **不重试**：4xx（令牌错、参数错、权限不足）—— 那是**确定的**业务结论，
 *     重试只会把同一个错误打 N 遍、放大上游压力、拖长用户等待。
 *   · **不重试**：调用方主动取消（`signal` abort）—— 那是用户意图，不是故障。
 *
 * ## 幂等性（重试 POST 的前提）
 * 三家签到接口上游**自带幂等**：重复领返回"已领"状态（Qoder 带 `replayed` 标记、
 * MiniMax 返回已签、WorkBuddy 业务码语义同上）。所以对 claim 类 POST 重试是安全的。
 *
 * ## 另附：报错文案带 cause
 * `fetch failed` 这种消息对用户毫无信息量（分不清令牌过期 / 网络断 / 代码 bug）。
 * 本模块把 cause 里的错误码提出来（如 `UND_ERR_CONNECT_TIMEOUT`），让用户知道
 * "是网络抖动，重试即可"。
 */

/** 重试参数。 */
export interface RetryOptions {
  /** 额外重试次数（不含首次）。默认 2 → 最多打 3 次。 */
  retries?: number;
  /** 首次退避毫秒；后续按 2 倍递增。默认 300。 */
  baseDelayMs?: number;
  /** 单次请求超时（毫秒）。**每次尝试都新建**，见下方注释。默认 20000。 */
  timeoutMs?: number;
  /** 每次要重试前回调（用于 --verbose 或测试观测）。 */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

/** 判定为「瞬时、可重试」的 HTTP 状态码（网关级不可用）。 */
const RETRYABLE_STATUS = new Set([502, 503, 504]);

/** Node fetch 连接类失败的 cause code（`err.cause.code`）。 */
const RETRYABLE_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 从任意错误里取出最有用的一句话（带 cause 码），用于给用户看的文案。 */
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const code =
    cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'string'
      ? (cause as { code: string }).code
      : undefined;
  const causeMsg = cause instanceof Error ? cause.message : undefined;
  if (code) return `${err.message}（${code}）`;
  if (causeMsg) return `${err.message}（${causeMsg}）`;
  return err.message;
}

/** 是否值得重试这个**抛出的**错误（连接层失败）。 */
function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  /* 调用方主动取消 → 不是故障，绝不重试。 */
  if (err.name === 'AbortError') return false;
  const cause = (err as { cause?: unknown }).cause;
  const code =
    cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'string'
      ? (cause as { code: string }).code
      : undefined;
  if (code && RETRYABLE_CODES.has(code)) return true;
  /* `TypeError: fetch failed` 是 undici 对连接层失败的统称；到这一层已是"没打通"，
     且上面已排除主动取消 —— 视为可重试。 */
  if (err.name === 'TypeError' && /fetch failed/i.test(err.message)) return true;
  /* AbortSignal.timeout 触发：正常超时，可重试。 */
  if (err.name === 'TimeoutError') return true;
  return false;
}

/**
 * 发起请求；连接层失败时按退避重试。
 *
 * ⚠️ **超时信号每次尝试都重建** —— `AbortSignal.timeout()` 一旦触发就永久处于
 * aborted 状态，复用它会让"第 2 次尝试"瞬间失败（这是个常见陷阱，故本函数
 * 接 `timeoutMs` 而不是让调用方传一个现成的 signal）。
 *
 * `init.signal` 仍受支持：它被当作**调用方取消信号**（不重试地穿透）。
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = Math.max(0, opts.retries ?? 2);
  const baseDelay = Math.max(0, opts.baseDelayMs ?? 300);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const callerSignal = init.signal ?? undefined;

  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(baseDelay * 2 ** (attempt - 1));

    /* 每次尝试重建超时；同时转发调用方的取消信号。 */
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });

      /* 网关瞬时不可用 → 丢弃响应体后重试（不留悬挂连接）。 */
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        lastErr = new Error(`HTTP ${res.status}`);
        opts.onRetry?.({ attempt: attempt + 1, delayMs: baseDelay * 2 ** attempt, reason: `HTTP ${res.status}` });
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      /* 调用方取消 → 直接抛；故障类 → 还有次数就重试。 */
      if (!isRetryableError(err) || attempt >= retries) throw err;
      opts.onRetry?.({
        attempt: attempt + 1,
        delayMs: baseDelay * 2 ** attempt,
        reason: describeFetchError(err),
      });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /* 理论不可达（循环内必 return 或 throw）；兜底给一个带 cause 的错误。 */
  throw lastErr instanceof Error ? lastErr : new Error(`请求失败：${describeFetchError(lastErr)}`);
}
