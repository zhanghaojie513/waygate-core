/**
 * 本地反代 HTTP 服务骨架。
 *
 * 职责边界（刻意收窄）：只做「收请求 → 交给适配器 → 把 SSE 流原样吐回」。
 * 协议翻译、凭证、模型清单全在**适配器**里 —— core 不含任何上游知识，
 * 所以两家适配器共用这一个服务实现，改一处两家都受益。
 *
 * 暴露的端点（与 OpenAI / Anthropic 客户端约定一致）：
 *   POST /v1/chat/completions   OpenAI 兼容聊天（Cursor / Cherry Studio 等）
 *   POST /v1/messages           Anthropic 兼容聊天（Claude Code 等）
 *   GET  /v1/models             模型列表（OpenAI 形状）
 *   GET  /healthz               健康检查（无鉴权，供探活）
 *
 * 安全默认：只监听回环地址；`--host 0.0.0.0` 需显式指定并打印警告。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Adapter, ChatMessage, ChatRequestBody } from './types.js';

export interface ServeOptions {
  host: string;
  port: number;
  /** 入站密钥；请求需带 `Authorization: Bearer <key>` 或 `x-api-key: <key>`。 */
  apiKey: string;
  verbose?: boolean;
  /** 请求日志（默认 stdout）。 */
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  /** 关停（等现有连接结束）。 */
  close(): Promise<void>;
}

/** 从入站头里取密钥（OpenAI 用 Bearer，Anthropic 用 x-api-key）。 */
function extractKey(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  return null;
}

async function readJsonBody(req: IncomingMessage, limitBytes = 8 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** OpenAI 形状的错误体（客户端普遍认这个）。 */
function sendError(res: ServerResponse, status: number, message: string, code = 'upstream_error'): void {
  sendJson(res, status, { error: { message, type: 'waygate_error', code } });
}

/**
 * 启动服务。适配器提供协议侧的一切（凭证、翻译、流）。
 */
export function startServer(adapter: Adapter, opts: ServeOptions): Promise<RunningServer> {
  const log = opts.log ?? ((line: string) => process.stdout.write(line + '\n'));

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log(`[错误] ${message}`);
      if (!res.headersSent) sendError(res, 502, message);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';

    /* 健康检查：无鉴权（探活用）。 */
    if (path === '/healthz') {
      sendJson(res, 200, { ok: true, service: adapter.command, upstream: adapter.upstreamLabel });
      return;
    }

    /* 鉴权：其余端点都要密钥。 */
    const provided = extractKey(req);
    if (provided !== opts.apiKey) {
      sendError(res, 401, '入站密钥缺失或不正确（Authorization: Bearer <key> 或 x-api-key）', 'invalid_api_key');
      return;
    }

    if (path === '/v1/models' && req.method === 'GET') {
      const models = await adapter.listModels();
      sendJson(res, 200, {
        object: 'list',
        data: models.map((m) => ({ id: m.id, object: 'model', owned_by: adapter.command, created: 0 })),
      });
      return;
    }

    if ((path === '/v1/chat/completions' || path === '/v1/messages') && req.method === 'POST') {
      const raw = (await readJsonBody(req)) as Partial<ChatRequestBody>;
      if (!raw || typeof raw.model !== 'string' || !raw.model.trim()) {
        sendError(res, 400, 'model 为必填项', 'invalid_request_error');
        return;
      }
      if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
        sendError(res, 400, 'messages 为必填项且不能为空', 'invalid_request_error');
        return;
      }

      const body: ChatRequestBody = { ...raw, model: raw.model, messages: raw.messages as ChatMessage[] };
      if (opts.verbose) log(`[请求] ${adapter.command} model=${body.model} messages=${body.messages.length} 流=${body.stream !== false}`);

      /* 客户端断连即中止上游（不留下孤儿请求）。 */
      const ac = new AbortController();
      req.on('close', () => ac.abort());

      const result = await adapter.chat(body, ac.signal);

      res.writeHead(result.status, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const reader = result.stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) res.write(value);
        }
      } finally {
        reader.releaseLock();
        res.end();
      }
      return;
    }

    sendError(res, 404, `未知端点 ${path}`, 'not_found');
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            /* 已建的 keep-alive 连接不主动断，close 会等它们；给一个兜底超时。 */
            setTimeout(() => done(), 3000).unref?.();
          }),
      });
    });
  });
}
