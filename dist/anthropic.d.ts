/**
 * Anthropic 兼容层（2026-10-17）。
 *
 * ## 为什么在 core
 * 三个独立工具的 README 都承诺「Anthropic 兼容 · Claude Code 可直连」，而 core
 * 此前**只有 OpenAI 一个出口** —— `/v1/messages` 收的是 Anthropic 请求，吐回去的
 * 却是 `data: {"object":"chat.completion.chunk",...}`。Anthropic 客户端（Claude Code、
 * ZCode 的 anthropic 协议模式）按 `event: message_start / content_block_delta / …`
 * 解析，收到 OpenAI 形状直接报 `invalid_union: no matching discriminator "type"`。
 *
 * **上游协议翻译在各适配器，出口协议是 core 的职责** —— 所以这一层放这里，
 * 三家一次受益（与 waygate-open `proxy/anthropic/*` 同源实现）。
 *
 * 三块：
 *   ① 入站归一 `anthropicToOpenAiBody`：顶层 `system` / content blocks / `tools`
 *      → 各家适配器已经在吃的 OpenAI 形状（它们只认 `messages[].content` 为串）。
 *   ② 出站编码 `AnthropicStreamEncoder` + `openAiSseToAnthropicFrames`：
 *      OpenAI SSE chunk → Anthropic SSE 事件序列。
 *   ③ 出口形状 `toAnthropicMessage` / `toAnthropicErrorBody`：非流式 message 与错误体。
 *
 * 事件序列（Anthropic 规范，顺序固定）：
 *   message_start → (content_block_start → content_block_delta* → content_block_stop)+
 *   → message_delta → message_stop
 */
import type { ChatRequestBody } from './types.js';
/** 生成本服务自己的 Anthropic 消息 id（`msg_` 前缀 —— 是**我们**产出的响应 id）。 */
export declare function newMessageId(): string;
/** 组装一个 Anthropic SSE 事件帧（`event:` 行 + `data:` 行 + 空行分隔）。 */
export declare function sseFrame(event: string, data: unknown): string;
/** OpenAI `finish_reason` → Anthropic `stop_reason`。 */
export declare function mapStopReason(finishReason: string | null | undefined): string;
/** HTTP 状态 → Anthropic `error.type`。 */
export declare function anthropicErrorType(status: number): string;
/**
 * Anthropic 形状的错误体。
 *
 * ⚠️ 与 OpenAI **不同**：Anthropic 是 `{type:"error", error:{type, message}}`，
 * OpenAI 是 `{error:{message, type, code}}`。Anthropic 客户端按前者解析。
 */
export declare function toAnthropicErrorBody(status: number, message: string): unknown;
/** `system`（string 或 text blocks）→ 单段文本；无 system 返回 null。 */
export declare function flattenSystem(system: unknown): string | null;
/**
 * Anthropic 请求体 → OpenAI 形状的 `ChatRequestBody`（各家适配器直接可用）。
 *
 * 只做翻译；**未识别字段一律忽略**（不报错、也不透传）—— 与 `/v1/chat/completions`
 * 的「静默丢弃未知字段」口径一致，避免客户端带一个新字段就把整个请求打挂。
 *
 * 校验由调用方（server）先行；本函数假设 `model` / `messages` 已合法，
 * 也会再兜一层，避免导出后被误用于未校验输入。
 */
export declare function anthropicToOpenAiBody(raw: Record<string, unknown>): ChatRequestBody;
/**
 * OpenAI chunk → Anthropic SSE 事件编码器（**流式**）。
 *
 * 逐块透传：`push()` 每收一个 chunk 就返回该产出的帧，调用方立即 flush —— 不缓冲。
 *
 * 用法（顺序固定）：
 *   `start()` → `push(chunk)`*（每个 chunk）→ `finish()`
 */
export declare class AnthropicStreamEncoder {
    private readonly messageId;
    private readonly model;
    private blockIndex;
    private open;
    /** OpenAI 的 `tool_calls[].index` → 我们分配的内容块索引。 */
    private readonly toolBlocks;
    private lastUsage;
    private finishReason;
    constructor(messageId: string, model: string);
    /** 首个事件：message_start。 */
    start(): string;
    /** 折叠一个上游 chunk，返回该 chunk 产出的 SSE 帧（可能为空串）。 */
    push(chunk: unknown): string;
    /** 收尾：闭合打开的内容块，发 message_delta + message_stop。 */
    finish(): string;
    private closeOpen;
    private textDelta;
    private toolDelta;
}
/**
 * OpenAI SSE 字节流 → Anthropic SSE 帧序列。
 *
 * - 首帧前不发任何东西，收到第一个有效 chunk 才发 `message_start`（避免上游一上来就
 *   失败时已写 200 空壳）。
 * - `[DONE]` 是 OpenAI 专有终帧标记，**Anthropic 无此物** —— 直接吞掉，由 `finish()`
 *   发 `message_stop` 收尾。
 * - 流自然结束（无论有没有 `[DONE]`）都补 `finish()`，不让客户端吊在半截。
 */
export declare function openAiSseToAnthropicFrames(stream: ReadableStream<Uint8Array>, model: string, messageId: string): AsyncGenerator<string>;
export interface AnthropicMessageParams {
    id: string;
    model: string;
    content: string;
    toolCalls?: Array<{
        id?: string;
        function?: {
            name?: string;
            arguments?: string;
        };
    }>;
    finishReason: string | null;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
    } | null;
}
/** 组装 Anthropic **非流式** `message` 响应体。 */
export declare function toAnthropicMessage(params: AnthropicMessageParams): unknown;
