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

import { randomBytes } from 'node:crypto';
import type { ChatMessage, ChatRequestBody } from './types.js';

/* ============================== 公共小件 ============================== */

/** 生成本服务自己的 Anthropic 消息 id（`msg_` 前缀 —— 是**我们**产出的响应 id）。 */
export function newMessageId(): string {
  return `msg_${randomBytes(12).toString('hex')}`;
}

/** 组装一个 Anthropic SSE 事件帧（`event:` 行 + `data:` 行 + 空行分隔）。 */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** OpenAI `finish_reason` → Anthropic `stop_reason`。 */
export function mapStopReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    case 'stop':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

/** HTTP 状态 → Anthropic `error.type`。 */
export function anthropicErrorType(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 413:
      return 'request_too_large';
    case 429:
      return 'rate_limit_error';
    case 529:
      return 'overloaded_error';
    default:
      return status >= 500 ? 'api_error' : 'invalid_request_error';
  }
}

/**
 * Anthropic 形状的错误体。
 *
 * ⚠️ 与 OpenAI **不同**：Anthropic 是 `{type:"error", error:{type, message}}`，
 * OpenAI 是 `{error:{message, type, code}}`。Anthropic 客户端按前者解析。
 */
export function toAnthropicErrorBody(status: number, message: string): unknown {
  return { type: 'error', error: { type: anthropicErrorType(status), message } };
}

/* ============================ ① 入站归一 ============================ */

/** content 里的一个块（宽松形状 —— 只读我们认识的字段，其余忽略）。 */
type Block = Record<string, unknown>;

function isTextBlock(b: Block): b is { type: 'text'; text: string } {
  return b.type === 'text' && typeof b.text === 'string';
}

/** `system`（string 或 text blocks）→ 单段文本；无 system 返回 null。 */
export function flattenSystem(system: unknown): string | null {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    const parts = system
      .filter((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && isTextBlock(b as Block))
      .map((b) => b.text);
    return parts.length > 0 ? parts.join('\n') : '';
  }
  return null;
}

/** Anthropic image block → OpenAI `image_url` part；识别不了返回 null（忽略）。 */
function imageToPart(b: Block): Block | null {
  const src = b.source as Block | undefined;
  if (!src || typeof src !== 'object') return null;
  if (src.type === 'base64' && typeof src.data === 'string') {
    const mediaType = typeof src.media_type === 'string' ? src.media_type : 'image/png';
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${src.data}` } };
  }
  if (src.type === 'url' && typeof src.url === 'string') {
    return { type: 'image_url', image_url: { url: src.url } };
  }
  return null;
}

/** `tool_result.content`（string 或 text blocks）→ 纯文本。 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof (c as Block).text === 'string' ? String((c as Block).text) : '')).join('');
  }
  return '';
}

/** assistant 的一条消息：text 拼成 content，tool_use 变成 tool_calls。 */
function convertAssistant(content: unknown): ChatMessage {
  if (typeof content === 'string') return { role: 'assistant', content };
  const texts: string[] = [];
  const calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
  for (const raw of Array.isArray(content) ? content : []) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as Block;
    if (isTextBlock(b)) {
      texts.push(b.text);
      continue;
    }
    if (b.type === 'tool_use') {
      calls.push({
        id: typeof b.id === 'string' ? b.id : '',
        type: 'function',
        function: {
          name: typeof b.name === 'string' ? b.name : '',
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    }
  }
  const out: ChatMessage = { role: 'assistant', content: texts.length > 0 ? texts.join('') : null };
  if (calls.length > 0) out.tool_calls = calls;
  return out;
}

/**
 * 一条 user 消息可能带 tool_result（客户端把工具结果回传）。
 * OpenAI 要求 tool_result 落成独立的 `role:"tool"` 消息；其余文本/图片落成一条 `role:"user"`。
 */
function convertUser(content: unknown): ChatMessage[] {
  if (typeof content === 'string') return [{ role: 'user', content }];
  const parts: Block[] = [];
  const toolMsgs: ChatMessage[] = [];
  for (const raw of Array.isArray(content) ? content : []) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as Block;
    if (isTextBlock(b)) {
      parts.push({ type: 'text', text: b.text });
      continue;
    }
    if (b.type === 'image') {
      const p = imageToPart(b);
      if (p) parts.push(p);
      continue;
    }
    if (b.type === 'tool_result') {
      toolMsgs.push({
        role: 'tool',
        content: toolResultText(b.content),
        tool_call_id: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
      });
    }
  }
  const out: ChatMessage[] = [...toolMsgs];
  if (parts.length > 0) {
    const onlyText = parts.every((p) => p.type === 'text');
    out.push({ role: 'user', content: onlyText ? parts.map((p) => String(p.text)).join('') : parts });
  }
  return out.length > 0 ? out : [{ role: 'user', content: '' }];
}

/** `tools:[{name,description,input_schema}]` → OpenAI function tools。 */
function convertTools(tools: unknown): Block[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out = tools
    .filter((t): t is Block => !!t && typeof t === 'object' && typeof (t as Block).name === 'string')
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: typeof t.description === 'string' ? t.description : '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
  return out.length > 0 ? out : undefined;
}

/** `tool_choice` → OpenAI（auto / required / none / {function:{name}}）。 */
function convertToolChoice(choice: unknown): unknown {
  if (!choice || typeof choice !== 'object') return undefined;
  const c = choice as Block;
  switch (c.type) {
    case 'auto':
      return 'auto';
    case 'any': // Anthropic「必须用某个工具」≈ OpenAI「required」
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return { type: 'function', function: { name: typeof c.name === 'string' ? c.name : '' } };
    default:
      return undefined;
  }
}

/**
 * Anthropic 请求体 → OpenAI 形状的 `ChatRequestBody`（各家适配器直接可用）。
 *
 * 只做翻译；**未识别字段一律忽略**（不报错、也不透传）—— 与 `/v1/chat/completions`
 * 的「静默丢弃未知字段」口径一致，避免客户端带一个新字段就把整个请求打挂。
 *
 * 校验由调用方（server）先行；本函数假设 `model` / `messages` 已合法，
 * 也会再兜一层，避免导出后被误用于未校验输入。
 */
export function anthropicToOpenAiBody(raw: Record<string, unknown>): ChatRequestBody {
  const model = raw.model;
  if (typeof model !== 'string' || model.trim() === '') throw new Error('model 为必填项，且必须是非空字符串');
  if (!Array.isArray(raw.messages)) throw new Error('messages 字段缺失或不是数组');

  const messages: ChatMessage[] = [];
  const system = flattenSystem(raw.system);
  if (typeof system === 'string' && system.trim() !== '') {
    messages.push({ role: 'system', content: system });
  }

  for (const m of raw.messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role === 'assistant') messages.push(convertAssistant(msg.content));
    else messages.push(...convertUser(msg.content));
  }

  const body: ChatRequestBody = { model, messages };
  /* `stream` 是传输层开关，由 core 自己消费（决定聚合还是透传）—— 必须原样带过去，
     否则 Anthropic 客户端发 `stream:false` 会被当成缺省（= 流式），拿到一坨 SSE。 */
  if (typeof raw.stream === 'boolean') body.stream = raw.stream;
  if (typeof raw.max_tokens === 'number' && Number.isFinite(raw.max_tokens)) body.max_tokens = raw.max_tokens;
  if (typeof raw.temperature === 'number') body.temperature = raw.temperature;
  if (typeof raw.top_p === 'number') body.top_p = raw.top_p;
  if (Array.isArray(raw.stop_sequences)) {
    const stop = raw.stop_sequences.filter((s): s is string => typeof s === 'string');
    if (stop.length > 0) body.stop = stop;
  }
  const tools = convertTools(raw.tools);
  if (tools) body.tools = tools;
  const toolChoice = convertToolChoice(raw.tool_choice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  return body;
}

/* ============================ ② 出站编码 ============================ */

interface OpenAiChunk {
  choices?: Array<{
    delta?: { content?: unknown; tool_calls?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: unknown;
}

interface ToolCallDelta {
  index?: unknown;
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

interface OpenBlock {
  kind: 'text' | 'tool';
  index: number;
}

/**
 * OpenAI chunk → Anthropic SSE 事件编码器（**流式**）。
 *
 * 逐块透传：`push()` 每收一个 chunk 就返回该产出的帧，调用方立即 flush —— 不缓冲。
 *
 * 用法（顺序固定）：
 *   `start()` → `push(chunk)`*（每个 chunk）→ `finish()`
 */
export class AnthropicStreamEncoder {
  private blockIndex = 0;
  private open: OpenBlock | null = null;
  /** OpenAI 的 `tool_calls[].index` → 我们分配的内容块索引。 */
  private readonly toolBlocks = new Map<number, number>();
  private lastUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  private finishReason: string | null = null;

  constructor(
    private readonly messageId: string,
    private readonly model: string,
  ) {}

  /** 首个事件：message_start。 */
  start(): string {
    return sseFrame('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        // ⚠️ input/output 此时**拿不到**（上游要流结束才有 usage）：以 0 占位，
        //    权威值随后在 message_delta 给出。Anthropic 自己在 message_start 也用 output_tokens:0。
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  /** 折叠一个上游 chunk，返回该 chunk 产出的 SSE 帧（可能为空串）。 */
  push(chunk: unknown): string {
    if (!chunk || typeof chunk !== 'object') return '';
    const c = chunk as OpenAiChunk;
    let out = '';
    if (c.usage && typeof c.usage === 'object') {
      this.lastUsage = c.usage as { prompt_tokens?: number; completion_tokens?: number };
    }

    const choices = Array.isArray(c.choices) ? c.choices : [];
    for (const choice of choices) {
      const delta = choice?.delta;
      if (delta) {
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          out += this.textDelta(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) out += this.toolDelta(call as ToolCallDelta);
        }
      }
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') {
        this.finishReason = choice.finish_reason;
      }
    }
    return out;
  }

  /** 收尾：闭合打开的内容块，发 message_delta + message_stop。 */
  finish(): string {
    let out = this.closeOpen();
    const usage = this.lastUsage;
    out += sseFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapStopReason(this.finishReason), stop_sequence: null },
      usage: {
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? 0,
      },
    });
    out += sseFrame('message_stop', { type: 'message_stop' });
    return out;
  }

  private closeOpen(): string {
    if (!this.open) return '';
    const frame = sseFrame('content_block_stop', { type: 'content_block_stop', index: this.open.index });
    this.open = null;
    return frame;
  }

  private textDelta(text: string): string {
    let out = '';
    if (!this.open || this.open.kind !== 'text') {
      out += this.closeOpen();
      this.open = { kind: 'text', index: this.blockIndex++ };
      out += sseFrame('content_block_start', {
        type: 'content_block_start',
        index: this.open.index,
        content_block: { type: 'text', text: '' },
      });
    }
    out += sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: this.open.index,
      delta: { type: 'text_delta', text },
    });
    return out;
  }

  private toolDelta(call: ToolCallDelta): string {
    const toolIndex = typeof call.index === 'number' ? call.index : 0;
    let blockIndex = this.toolBlocks.get(toolIndex);
    let out = '';

    if (blockIndex === undefined) {
      out += this.closeOpen();
      blockIndex = this.blockIndex++;
      this.toolBlocks.set(toolIndex, blockIndex);
      this.open = { kind: 'tool', index: blockIndex };
      out += sseFrame('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: {
          type: 'tool_use',
          id: typeof call.id === 'string' ? call.id : '',
          name: typeof call.function?.name === 'string' ? call.function.name : '',
          input: {},
        },
      });
    } else if (!this.open || this.open.index !== blockIndex) {
      // 罕见：文本块与该工具块交错出现 → 先收口当前块，再继续该工具块（不重复发 start）
      out += this.closeOpen();
      this.open = { kind: 'tool', index: blockIndex };
    }

    const args = call.function?.arguments;
    if (typeof args === 'string' && args.length > 0) {
      out += sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: args },
      });
    }
    return out;
  }
}

/** 从一帧 SSE 文本里取 `data:` 载荷；无 data 行（注释/心跳）返回 null。 */
function extractData(frame: string): string | null {
  for (const line of frame.split('\n')) {
    const t = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (t.startsWith('data:')) return t.slice(5).trim();
  }
  return null;
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
export async function* openAiSseToAnthropicFrames(
  stream: ReadableStream<Uint8Array>,
  model: string,
  messageId: string,
): AsyncGenerator<string> {
  const encoder = new AnthropicStreamEncoder(messageId, model);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let started = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const payload = extractData(frame);
        if (payload === null || payload === '[DONE]') continue;

        let chunk: unknown;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // 坏帧（上游杂音），跳过
        }
        if (!started) {
          started = true;
          yield encoder.start();
        }
        const out = encoder.push(chunk);
        if (out) yield out;
      }
    }
    if (!started) yield encoder.start();
    yield encoder.finish();
  } finally {
    reader.releaseLock();
  }
}

/* ============================ ③ 出口形状 ============================ */

/** `tool_calls[].function.arguments`（JSON 串）→ Anthropic `input` 对象。 */
function parseToolInput(argumentsJson: unknown): unknown {
  if (typeof argumentsJson !== 'string' || !argumentsJson) return {};
  try {
    return JSON.parse(argumentsJson);
  } catch {
    // 上游给了坏 JSON：不编造，退化为空对象（Anthropic 要求 input 是对象）
    return {};
  }
}

export interface AnthropicMessageParams {
  id: string;
  model: string;
  content: string;
  toolCalls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** 组装 Anthropic **非流式** `message` 响应体。 */
export function toAnthropicMessage(params: AnthropicMessageParams): unknown {
  const content: unknown[] = [];
  if (typeof params.content === 'string' && params.content.length > 0) {
    content.push({ type: 'text', text: params.content });
  }
  for (const call of params.toolCalls ?? []) {
    content.push({
      type: 'tool_use',
      id: call.id ?? '',
      name: call.function?.name ?? '',
      input: parseToolInput(call.function?.arguments),
    });
  }
  return {
    id: params.id,
    type: 'message',
    role: 'assistant',
    model: params.model,
    content,
    stop_reason: mapStopReason(params.finishReason),
    stop_sequence: null,
    usage: {
      // usage 缺失时以 0 占位（Anthropic 结构要求该字段存在）
      input_tokens: params.usage?.prompt_tokens ?? 0,
      output_tokens: params.usage?.completion_tokens ?? 0,
    },
  };
}
