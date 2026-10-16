/**
 * 本地反代 HTTP 服务骨架。
 *
 * 职责边界（刻意收窄）：只做「收请求 → 交给适配器 → 把结果吐回」。
 * **上游**协议翻译、凭证、模型清单全在**适配器**里 —— core 不含任何上游知识，
 * 所以各家适配器共用这一个服务实现，改一处各家都受益。
 *
 * **出口协议是 core 的职责**（见 `anthropic.ts`）：`/v1/messages` 收的是 Anthropic
 * 请求，就必须按 Anthropic 的 `event:` 事件序列回 —— 否则 Claude Code 等客户端
 * 解析必失败（它们按 `message_start` / `content_block_delta` 认，不认 OpenAI 的
 * `chat.completion.chunk`）。`/v1/chat/completions` 仍走 OpenAI 形状。
 *
 * 暴露的端点（与 OpenAI / Anthropic 客户端约定一致）：
 *   POST /v1/chat/completions   OpenAI 兼容聊天（Cursor / Cherry Studio 等）
 *   POST /v1/messages           Anthropic 兼容聊天（Claude Code 等）
 *   GET  /v1/models             模型列表（OpenAI 形状）
 *   GET  /healthz               健康检查（无鉴权，供探活）
 *
 * 安全默认：只监听回环地址；`--host 0.0.0.0` 需显式指定并打印警告。
 */
import { createServer } from 'node:http';
import { aggregateSseToJson } from './aggregate.js';
import { createSseDeltaNormalizer } from './sse-delta.js';
import { anthropicToOpenAiBody, newMessageId, openAiSseToAnthropicFrames, toAnthropicErrorBody, toAnthropicMessage, } from './anthropic.js';
/** 从入站头里取密钥（OpenAI 用 Bearer，Anthropic 用 x-api-key）。 */
function extractKey(req) {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
        return auth.slice(7).trim();
    }
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.trim())
        return apiKey.trim();
    return null;
}
async function readJsonBody(req, limitBytes = 8 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = chunk;
        size += buf.length;
        if (size > limitBytes)
            throw new Error('请求体过大');
        chunks.push(buf);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
}
function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
}
/** OpenAI 形状的错误体（客户端普遍认这个）。 */
function sendError(res, status, message, code = 'upstream_error') {
    sendJson(res, status, { error: { message, type: 'waygate_error', code } });
}
/** Anthropic 形状的错误体（`/v1/messages` 的客户端只认这个）。 */
function sendAnthropicError(res, status, message) {
    sendJson(res, status, toAnthropicErrorBody(status, message));
}
/**
 * 启动服务。适配器提供**上游**协议侧的一切（凭证、翻译、流）。
 */
export function startServer(adapter, opts) {
    const log = opts.log ?? ((line) => process.stdout.write(line + '\n'));
    const server = createServer((req, res) => {
        void handle(req, res).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            log(`[错误] ${message}`);
            /* 兜底错误（如适配器抛的凭证错）也必须按端点给形状：`/v1/messages` 的客户端
               只认 Anthropic 的 `{type:"error",error:{...}}`，给它 OpenAI 体会解析失败。 */
            if (!res.headersSent) {
                const p = (req.url ?? '/').split('?')[0] ?? '/';
                const route = p.startsWith('/v1/') ? p.slice(3) : p;
                if (route === '/messages')
                    sendAnthropicError(res, 502, message);
                else
                    sendError(res, 502, message);
            }
            else {
                res.end();
            }
        });
    });
    async function handle(req, res) {
        const url = req.url ?? '/';
        const path = url.split('?')[0] ?? '/';
        /* 健康检查：无鉴权（探活用）。 */
        if (path === '/healthz') {
            sendJson(res, 200, { ok: true, service: adapter.command, upstream: adapter.upstreamLabel });
            return;
        }
        /* [v0.2.2] 路径兼容：客户端对 base_url 的填法不一 —— 有的填 `http://host:port/v1`
           （拼出 /v1/chat/completions），有的填 `http://host:port`（拼出 /chat/completions）。
           两种都接受，避免"多一个 /v1 就 404"这类让人摸不着头脑的失败。
           [v0.2.8] 这条对 `/v1/messages` 同样成立（Claude Code 自己会补 /v1）。 */
        const normalize = (p) => (p.startsWith('/v1/') ? p.slice(3) : p);
        const route = normalize(path);
        /** 本请求是否走 Anthropic 出口（决定入站解析、出站编码、错误形状三处）。 */
        const isAnthropic = route === '/messages';
        /* 鉴权：除健康检查外都要密钥。 */
        const provided = extractKey(req);
        if (provided !== opts.apiKey) {
            if (isAnthropic)
                sendAnthropicError(res, 401, '入站密钥缺失或不正确（x-api-key 或 Authorization: Bearer <key>）');
            else
                sendError(res, 401, '入站密钥缺失或不正确（Authorization: Bearer <key> 或 x-api-key）', 'invalid_api_key');
            return;
        }
        const fail = (status, message, code = 'invalid_request_error') => {
            if (isAnthropic)
                sendAnthropicError(res, status, message);
            else
                sendError(res, status, message, code);
        };
        if (route === '/models' && req.method === 'GET') {
            const models = await adapter.listModels();
            sendJson(res, 200, {
                object: 'list',
                data: models.map((m) => ({ id: m.id, object: 'model', owned_by: adapter.command, created: 0 })),
            });
            return;
        }
        if ((route === '/chat/completions' || route === '/messages') && req.method === 'POST') {
            const raw = (await readJsonBody(req));
            if (!raw || typeof raw !== 'object') {
                fail(400, '请求体必须是 JSON 对象。');
                return;
            }
            if (typeof raw.model !== 'string' || !raw.model.trim()) {
                fail(400, 'model 为必填项');
                return;
            }
            if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
                fail(400, 'messages 为必填项且不能为空');
                return;
            }
            /* ★ 入站归一：Anthropic 的 `system`/content blocks/tools 折成适配器认识的
               OpenAI 形状（各适配器只读 `messages[].content` 为串，不做块解析）。 */
            let body;
            if (isAnthropic) {
                try {
                    body = anthropicToOpenAiBody(raw);
                }
                catch (err) {
                    fail(400, err.message);
                    return;
                }
            }
            else {
                body = { ...raw, model: raw.model, messages: raw.messages };
            }
            const wantsStream = body.stream !== false; // OpenAI 惯例：缺省 = 流式
            if (opts.verbose)
                log(`[请求] ${adapter.command} model=${body.model} messages=${body.messages.length} 流=${wantsStream} 协议=${isAnthropic ? 'anthropic' : 'openai'}`);
            /* 客户端断连即中止上游（不留下孤儿请求）。 */
            const ac = new AbortController();
            req.on('close', () => ac.abort());
            const result = await adapter.chat(body, ac.signal);
            /* ── 非流式 ── */
            if (!wantsStream) {
                try {
                    const json = await aggregateSseToJson(result.stream);
                    const completion = JSON.parse(json);
                    if (!isAnthropic) {
                        sendJson(res, result.status, completion);
                        return;
                    }
                    /* Anthropic 非流式：聚合成单个 `message` 对象（不是 chat.completion）。 */
                    const choice = completion.choices?.[0];
                    sendJson(res, result.status, toAnthropicMessage({
                        id: newMessageId(),
                        model: body.model,
                        content: typeof choice?.message?.content === 'string' ? choice.message.content : '',
                        toolCalls: Array.isArray(choice?.message?.tool_calls)
                            ? choice.message.tool_calls
                            : undefined,
                        finishReason: choice?.finish_reason ?? null,
                        usage: completion.usage ?? null,
                    }));
                }
                catch (err) {
                    if (!res.headersSent)
                        fail(502, `非流式聚合失败：${err.message}`, 'upstream_error');
                    else
                        res.end();
                }
                return;
            }
            /* ── 流式 ── */
            res.writeHead(result.status, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
                'x-accel-buffering': 'no',
            });
            if (isAnthropic) {
                /* Anthropic 出口：把上游的 OpenAI chunk 编码成 `event:` 事件序列。 */
                try {
                    for await (const frame of openAiSseToAnthropicFrames(result.stream, body.model, newMessageId())) {
                        res.write(frame);
                    }
                }
                catch (err) {
                    /* 已 writeHead(200)：只能用 Anthropic 的 error 事件告知，无法改状态码。 */
                    log(`[流错误] ${err.message}`);
                    res.write(`event: error\ndata: ${JSON.stringify(toAnthropicErrorBody(502, err.message))}\n\n`);
                }
                finally {
                    res.end();
                }
                return;
            }
            /* OpenAI 出口。★ delta 空值归一化（见 sse-delta.ts）：上游每帧塞满全量字段
               （思考帧带 `content:""`），ai-sdk 系客户端会把它当分段边界、把思考拆成一词一段 ——
               ZCode 里表现为一次回答堆出几十条「思考」。转发前剥掉空值，语义无损。 */
            const reader = result.stream.pipeThrough(createSseDeltaNormalizer()).getReader();
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    if (value)
                        res.write(value);
                }
            }
            finally {
                reader.releaseLock();
                res.end();
            }
            return;
        }
        fail(404, `未知端点 ${path}`, 'not_found');
    }
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host, () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : opts.port;
            resolve({
                port,
                close: () => new Promise((done) => {
                    server.close(() => done());
                    /* 已建的 keep-alive 连接不主动断，close 会等它们；给一个兜底超时。 */
                    setTimeout(() => done(), 3000).unref?.();
                }),
            });
        });
    });
}
