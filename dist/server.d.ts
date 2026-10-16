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
import type { Adapter } from './types.js';
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
/**
 * 启动服务。适配器提供**上游**协议侧的一切（凭证、翻译、流）。
 */
export declare function startServer(adapter: Adapter, opts: ServeOptions): Promise<RunningServer>;
