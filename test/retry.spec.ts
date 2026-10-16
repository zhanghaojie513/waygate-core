/**
 * `fetchWithRetry` 测试（假 fetch，不触真实上游）。
 *
 * 守的是**实测过的痛点**：上游活动/签到域有约 70% 的连接超时率，而原实现"打一次就完"，
 * 用户点签到七成概率看到 `fetch failed`。重试把成功率提上去，但**只能重试连接类失败**。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, describeFetchError } from '../src/retry.js';

afterEach(() => vi.unstubAllGlobals());

/** 造一个 undici 风格的连接失败（`TypeError: fetch failed` + cause.code）。 */
function connError(code = 'UND_ERR_CONNECT_TIMEOUT'): TypeError {
  const cause = Object.assign(new Error('connect timeout'), { code });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

const ok = (body = '{}', status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });

describe('fetchWithRetry：重试连接类失败', () => {
  it('★ 连续失败后成功 —— 这正是上层 ~70% 超时率的解药', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      if (n < 3) throw connError();
      return ok('{"ok":true}');
    }));
    const res = await fetchWithRetry('https://x/y', {}, { retries: 2, baseDelayMs: 1 });
    expect(res.status).toBe(200);
    expect(n).toBe(3); // 打满 3 次（1 首次 + 2 重试）才成功
  });

  it('重试次数用尽后抛最后一个错误（不无限重试）', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      throw connError();
    }));
    await expect(fetchWithRetry('https://x/y', {}, { retries: 2, baseDelayMs: 1 })).rejects.toThrow(/fetch failed/);
    expect(n).toBe(3); // 1 + 2
  });

  it('retries:0 → 只打一次（保持"不重试"的显式能力）', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      throw connError();
    }));
    await expect(fetchWithRetry('https://x/y', {}, { retries: 0, baseDelayMs: 1 })).rejects.toThrow();
    expect(n).toBe(1);
  });

  it('多种可重试 cause code 都认（ECONNRESET / EAI_AGAIN / ETIMEDOUT）', async () => {
    for (const code of ['ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_SOCKET']) {
      let n = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        n += 1;
        if (n === 1) throw connError(code);
        return ok();
      }));
      const res = await fetchWithRetry('https://x/y', {}, { retries: 1, baseDelayMs: 1 });
      expect(res.status, `code=${code} 应被重试`).toBe(200);
    }
  });

  it('网关 503/502/504 也重试（瞬时不可用）', async () => {
    for (const status of [502, 503, 504]) {
      let n = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        n += 1;
        return n === 1 ? new Response('gw', { status }) : ok();
      }));
      const res = await fetchWithRetry('https://x/y', {}, { retries: 1, baseDelayMs: 1 });
      expect(res.status).toBe(200);
      expect(n).toBe(2);
    }
  });
});

describe('fetchWithRetry：不重试的东西（同样重要）', () => {
  it('★ 4xx 不重试 —— 那是确定的业务结论（令牌错/参数错），重试只会放大错误', async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      let n = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        n += 1;
        return new Response('bad', { status });
      }));
      const res = await fetchWithRetry('https://x/y', {}, { retries: 2, baseDelayMs: 1 });
      expect(res.status).toBe(status);
      expect(n, `HTTP ${status} 不该重试`).toBe(1);
    }
  });

  it('★ 调用方主动取消（AbortError）不重试 —— 那是用户意图，不是故障', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }));
    await expect(fetchWithRetry('https://x/y', {}, { retries: 3, baseDelayMs: 1 })).rejects.toThrow(/aborted/);
    expect(n).toBe(1);
  });

  it('非连接类的普通异常不重试', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      throw new Error('某个业务异常');
    }));
    await expect(fetchWithRetry('https://x/y', {}, { retries: 3, baseDelayMs: 1 })).rejects.toThrow(/某个业务异常/);
    expect(n).toBe(1);
  });
});

describe('fetchWithRetry：超时信号每次重建（关键实现细节）', () => {
  it('★ 第一次超时后，第二次仍会真正发请求（复用旧 signal 会让第 2 次秒失败）', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      n += 1;
      const sig = init?.signal as AbortSignal | undefined;
      /* 第 1 次模拟超时（signal 已 aborted）；第 2 次必须拿到一个**新的、未 aborted** 的 signal。 */
      if (n === 1) {
        expect(sig?.aborted).toBe(false);
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }
      expect(sig?.aborted, '第 2 次的 signal 不该是已取消的旧对象').toBe(false);
      return ok();
    }));
    const res = await fetchWithRetry('https://x/y', {}, { retries: 1, baseDelayMs: 1, timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(n).toBe(2);
  });

  it('调用方 signal 已取消 → 立刻放弃，不发请求', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      n += 1;
      if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return ok();
    }));
    const ac = new AbortController();
    ac.abort();
    await expect(fetchWithRetry('https://x/y', { signal: ac.signal }, { retries: 2, baseDelayMs: 1 })).rejects.toThrow();
    expect(n).toBe(1);
  });
});

describe('describeFetchError：让 "fetch failed" 变得可行动', () => {
  it('★ 带出 cause 的 code（用户才知道是网络抖动、重试即可）', () => {
    expect(describeFetchError(connError('UND_ERR_CONNECT_TIMEOUT'))).toBe('fetch failed（UND_ERR_CONNECT_TIMEOUT）');
  });

  it('无 cause 时退回原消息，不编造', () => {
    expect(describeFetchError(new Error('plain'))).toBe('plain');
    expect(describeFetchError('字符串')).toBe('字符串');
  });

  it('cause 无 code 但有自己的消息 → 用消息', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: new Error('socket hang up') });
    expect(describeFetchError(err)).toBe('fetch failed（socket hang up）');
  });
});

describe('fetchWithRetry：onRetry 观测', () => {
  it('每次重试回调一次，带 reason 与递增 delay', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      if (n < 3) throw connError();
      return ok();
    }));
    const seen: Array<{ attempt: number; delayMs: number; reason: string }> = [];
    await fetchWithRetry('https://x/y', {}, { retries: 2, baseDelayMs: 10, onRetry: (i) => seen.push(i) });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.delayMs).toBe(10);
    expect(seen[1]!.delayMs).toBe(20); // 2 倍退避
    expect(seen[0]!.reason).toContain('UND_ERR_CONNECT_TIMEOUT');
  });
});
