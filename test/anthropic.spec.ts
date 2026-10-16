/**
 * Anthropic 兼容层测试（v0.2.8）。
 *
 * 覆盖三块：入站归一、出站编码、出口形状。
 * 不碰网络 —— 全部是纯函数 / 内存流。
 */

import { describe, expect, it } from 'vitest';
import {
  AnthropicStreamEncoder,
  anthropicErrorType,
  anthropicToOpenAiBody,
  flattenSystem,
  mapStopReason,
  newMessageId,
  openAiSseToAnthropicFrames,
  toAnthropicErrorBody,
  toAnthropicMessage,
} from '../src/anthropic.js';

/** 把一组 SSE 文本帧串成 ReadableStream<Uint8Array>（模拟上游 OpenAI SSE）。 */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
}

const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

/** 从 Anthropic SSE 文本里抽出事件名序列。 */
function eventNames(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('event:'))
    .map((l) => l.slice(6).trim());
}

/** 从 Anthropic SSE 文本里抽出某个事件的所有 data 载荷。 */
function payloads(text: string, event: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    if (!lines.some((l) => l === `event: ${event}`)) continue;
    const data = lines.find((l) => l.startsWith('data:'));
    if (data) out.push(JSON.parse(data.slice(5).trim()));
  }
  return out;
}

/* ============================ 入站归一 ============================ */

describe('anthropic：入站归一', () => {
  it('顶层 system（字符串）→ 首条 system 消息', () => {
    const body = anthropicToOpenAiBody({
      model: 'm',
      system: '你是助手',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    });
    expect(body.messages[0]).toEqual({ role: 'system', content: '你是助手' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(body.max_tokens).toBe(100);
  });

  it('顶层 system（text blocks 数组）→ 拼成一段', () => {
    const body = anthropicToOpenAiBody({
      model: 'm',
      system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'A\nB' });
  });

  it('user 的 content blocks（text）→ 拼成字符串', () => {
    const body = anthropicToOpenAiBody({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你' }, { type: 'text', text: '好' }] }],
    });
    expect(body.messages[0]).toEqual({ role: 'user', content: '你好' });
  });

  it('tool_result block → 独立 role:"tool" 消息（带 tool_call_id）', () => {
    const body = anthropicToOpenAiBody({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '结果' }] },
      ],
    });
    expect(body.messages).toEqual([{ role: 'tool', content: '结果', tool_call_id: 'call_1' }]);
  });

  it('assistant 的 tool_use block → tool_calls（arguments 序列化为 JSON 串）', () => {
    const body = anthropicToOpenAiBody({
      model: 'm',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'f', input: { a: 1 } }] },
      ],
    });
    expect(body.messages[0].tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
    ]);
  });

  it('tools（input_schema）→ OpenAI function tools', () => {
    const body = anthropicToOpenAiBody({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }],
    });
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } },
    ]);
  });

  it('tool_choice：any → required；tool → {function:{name}}', () => {
    const a = anthropicToOpenAiBody({ model: 'm', messages: [{ role: 'user', content: 'x' }], tool_choice: { type: 'any' } });
    expect(a.tool_choice).toBe('required');
    const b = anthropicToOpenAiBody({ model: 'm', messages: [{ role: 'user', content: 'x' }], tool_choice: { type: 'tool', name: 'f' } });
    expect(b.tool_choice).toEqual({ type: 'function', function: { name: 'f' } });
  });

  it('stop_sequences → stop；未识别字段被丢弃（不报错）', () => {
    const body = anthropicToOpenAiBody({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stop_sequences: ['END'],
      some_future_field: 123,
    });
    expect(body.stop).toEqual(['END']);
    expect(body).not.toHaveProperty('some_future_field');
    expect(body).not.toHaveProperty('stop_sequences');
  });

  it('model 缺失 / messages 非数组 → 抛错（调用方转 400）', () => {
    expect(() => anthropicToOpenAiBody({ messages: [] })).toThrow(/model/);
    expect(() => anthropicToOpenAiBody({ model: 'm' })).toThrow(/messages/);
  });

  it('★ stream 开关必须带过去（否则 stream:false 被当缺省=流式，客户端拿到一坨 SSE）', () => {
    const off = anthropicToOpenAiBody({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: false });
    expect(off.stream).toBe(false);
    const on = anthropicToOpenAiBody({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true });
    expect(on.stream).toBe(true);
    /* 未给 → 不新增该键（由 core 按缺省=流式处理） */
    const none = anthropicToOpenAiBody({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(none).not.toHaveProperty('stream');
  });

  it('flattenSystem：string / blocks / 缺省', () => {
    expect(flattenSystem('x')).toBe('x');
    expect(flattenSystem([{ type: 'text', text: 'a' }])).toBe('a');
    expect(flattenSystem(undefined)).toBeNull();
  });
});

/* ============================ 出站编码 ============================ */

describe('anthropic：出站编码（流式事件序列）', () => {
  it('★ 事件顺序：message_start → content_block_start → delta* → block_stop → message_delta → message_stop', () => {
    const enc = new AnthropicStreamEncoder('msg_1', 'm');
    let text = enc.start();
    text += enc.push({ choices: [{ delta: { content: '你' }, finish_reason: null }] });
    text += enc.push({ choices: [{ delta: { content: '好' }, finish_reason: null }] });
    text += enc.push({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    text += enc.finish();

    expect(eventNames(text)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });

  it('★ 完全不出现 OpenAI 形状（chat.completion.chunk / [DONE]）', () => {
    const enc = new AnthropicStreamEncoder('msg_1', 'm');
    const text = enc.start() + enc.push({ choices: [{ delta: { content: 'x' }, finish_reason: null }] }) + enc.finish();
    expect(text).not.toContain('chat.completion.chunk');
    expect(text).not.toContain('[DONE]');
  });

  it('message_start 带 id / model / 空的 content 与 usage 占位', () => {
    const enc = new AnthropicStreamEncoder('msg_abc', 'qfmodel');
    const start = payloads(enc.start(), 'message_start')[0] as { message: Record<string, unknown> };
    expect(start.message.id).toBe('msg_abc');
    expect(start.message.model).toBe('qfmodel');
    expect(start.message.role).toBe('assistant');
    expect(start.message.content).toEqual([]);
    expect(start.message.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('usage 取末帧并写入 message_delta（input/output 权威值）', () => {
    const enc = new AnthropicStreamEncoder('msg_1', 'm');
    enc.start();
    enc.push({ choices: [{ delta: { content: 'x' }, finish_reason: null }] });
    enc.push({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 22 } });
    const fin = enc.finish();
    const md = payloads(fin, 'message_delta')[0] as { usage: Record<string, unknown>; delta: Record<string, unknown> };
    expect(md.usage).toEqual({ input_tokens: 11, output_tokens: 22 });
    expect(md.delta.stop_reason).toBe('end_turn');
  });

  it('finish_reason 映射：length→max_tokens / tool_calls→tool_use', () => {
    const a = new AnthropicStreamEncoder('i', 'm');
    a.start();
    a.push({ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] });
    const da = payloads(a.finish(), 'message_delta')[0] as { delta: { stop_reason: string } };
    expect(da.delta.stop_reason).toBe('max_tokens');

    const b = new AnthropicStreamEncoder('i', 'm');
    b.start();
    b.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    const db = payloads(b.finish(), 'message_delta')[0] as { delta: { stop_reason: string } };
    expect(db.delta.stop_reason).toBe('tool_use');
  });

  it('tool_calls → content_block_start{tool_use} + input_json_delta 分段', () => {
    const enc = new AnthropicStreamEncoder('msg_1', 'm');
    let text = enc.start();
    text += enc.push({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"a"' } }] }, finish_reason: null }],
    });
    text += enc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: null }] });
    text += enc.finish();

    const starts = payloads(text, 'content_block_start') as Array<{ content_block: Record<string, unknown> }>;
    expect(starts[0].content_block).toEqual({ type: 'tool_use', id: 'call_1', name: 'f', input: {} });
    const deltas = payloads(text, 'content_block_delta') as Array<{ delta: Record<string, unknown> }>;
    expect(deltas.map((d) => d.delta.partial_json).join('')).toBe('{"a":1}');
    expect(deltas[0].delta.type).toBe('input_json_delta');
  });

  it('文本与工具交替：文本块先收口，再开工具块', () => {
    const enc = new AnthropicStreamEncoder('msg_1', 'm');
    let text = enc.start();
    text += enc.push({ choices: [{ delta: { content: '先说' }, finish_reason: null }] });
    text += enc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{}' } }] }, finish_reason: null }] });
    text += enc.finish();
    const names = eventNames(text);
    /* 文本 block_stop 必须出现在工具 block_start 之前 */
    expect(names.indexOf('content_block_stop')).toBeLessThan(names.lastIndexOf('content_block_start'));
  });

  it('mapStopReason 全量映射', () => {
    expect(mapStopReason('stop')).toBe('end_turn');
    expect(mapStopReason('length')).toBe('max_tokens');
    expect(mapStopReason('tool_calls')).toBe('tool_use');
    expect(mapStopReason('content_filter')).toBe('refusal');
    expect(mapStopReason(null)).toBe('end_turn');
  });
});

/* ====================== 流式：整条管道（含 [DONE] 处置） ====================== */

describe('anthropic：OpenAI SSE 流 → Anthropic 帧', () => {
  it('★ 吞掉 [DONE]，补 message_stop；事件序列完整', async () => {
    const stream = sseStream([
      frame({ id: 'x', model: 'm', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }),
      frame({ choices: [{ delta: { content: '你好' }, finish_reason: null }] }),
      frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]);
    let text = '';
    for await (const f of openAiSseToAnthropicFrames(stream, 'm', 'msg_1')) text += f;

    expect(text).not.toContain('[DONE]');
    const names = eventNames(text);
    expect(names[0]).toBe('message_start');
    expect(names[names.length - 1]).toBe('message_stop');
    expect(names).toContain('content_block_delta');
  });

  it('跨 chunk 的半帧不丢（按 \\n\\n 分帧）', async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        /* 故意把一帧劈成两半，中间不闭合 —— 前一半不足以成帧。 */
        const full = frame({ choices: [{ delta: { content: 'AB' }, finish_reason: null }] });
        c.enqueue(enc.encode(full.slice(0, 10)));
        c.enqueue(enc.encode(full.slice(10)));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    let text = '';
    for await (const f of openAiSseToAnthropicFrames(stream, 'm', 'msg_1')) text += f;
    const deltas = payloads(text, 'content_block_delta') as Array<{ delta: { text: string } }>;
    expect(deltas.map((d) => d.delta.text).join('')).toBe('AB');
  });

  it('上游无 [DONE] 自然结束，也补 finish()（不让客户端吊在半截）', async () => {
    const stream = sseStream([frame({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] })]);
    let text = '';
    for await (const f of openAiSseToAnthropicFrames(stream, 'm', 'msg_1')) text += f;
    expect(eventNames(text)).toContain('message_stop');
  });

  it('空流也发 start/stop（不产出半截消息）', async () => {
    const stream = sseStream([]);
    let text = '';
    for await (const f of openAiSseToAnthropicFrames(stream, 'm', 'msg_1')) text += f;
    /* 没有内容块，但 message_delta/message_stop 仍要发 —— 客户端靠 message_stop 收尾，
       否则会一直等下去。 */
    expect(eventNames(text)).toEqual(['message_start', 'message_delta', 'message_stop']);
    expect(text).not.toContain('content_block');
  });
});

/* ============================ 出口形状 ============================ */

describe('anthropic：非流式 message 与错误体', () => {
  it('toAnthropicMessage：content 数组含 text 块，stop_reason 映射', () => {
    const msg = toAnthropicMessage({
      id: 'msg_1',
      model: 'm',
      content: '答案',
      finishReason: 'stop',
      usage: { prompt_tokens: 5, completion_tokens: 7 },
    }) as Record<string, unknown>;
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('assistant');
    expect(msg.content).toEqual([{ type: 'text', text: '答案' }]);
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.usage).toEqual({ input_tokens: 5, output_tokens: 7 });
  });

  it('toAnthropicMessage：tool_calls → tool_use 块（input 解析回对象）', () => {
    const msg = toAnthropicMessage({
      id: 'msg_1',
      model: 'm',
      content: '',
      toolCalls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }],
      finishReason: 'tool_calls',
    }) as { content: unknown[]; stop_reason: string };
    expect(msg.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } }]);
    expect(msg.stop_reason).toBe('tool_use');
  });

  it('toAnthropicMessage：usage 缺失以 0 占位（结构要求字段存在）', () => {
    const msg = toAnthropicMessage({ id: 'i', model: 'm', content: 'x', finishReason: 'stop' }) as { usage: Record<string, number> };
    expect(msg.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('错误体是 Anthropic 形状（不是 OpenAI 的 error.message.code）', () => {
    const body = toAnthropicErrorBody(401, '没密钥') as { type: string; error: Record<string, unknown> };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.message).toBe('没密钥');
    expect(body.error).not.toHaveProperty('code');
  });

  it('anthropicErrorType 映射', () => {
    expect(anthropicErrorType(400)).toBe('invalid_request_error');
    expect(anthropicErrorType(401)).toBe('authentication_error');
    expect(anthropicErrorType(429)).toBe('rate_limit_error');
    expect(anthropicErrorType(529)).toBe('overloaded_error');
    expect(anthropicErrorType(500)).toBe('api_error');
  });

  it('newMessageId 带 msg_ 前缀且唯一', () => {
    const a = newMessageId();
    expect(a).toMatch(/^msg_[0-9a-f]{24}$/);
    expect(newMessageId()).not.toBe(a);
  });
});
