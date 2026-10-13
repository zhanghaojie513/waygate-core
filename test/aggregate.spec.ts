/**
 * SSE 聚合器测试：把流式 chunk 拼成单个 chat.completion JSON。
 * 覆盖：纯文本、reasoning、tool_calls 分片合并、usage 独立末帧、空流抛错。
 */

import { describe, expect, it } from 'vitest';
import { aggregateSseToJson } from '../src/aggregate.js';

/** 造一条 OpenAI SSE 流（每帧一个 chunk）。 */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

function chunk(delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1791900000,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  })}\n\n`;
}

describe('aggregateSseToJson', () => {
  it('纯文本：delta.content 拼接、role 取首个、finish 取末个', async () => {
    const json = await aggregateSseToJson(sseStream([
      chunk({ role: 'assistant' }),
      chunk({ content: '你' }),
      chunk({ content: '好' }),
      chunk({}, 'stop'),
      'data: [DONE]\n\n',
    ]));
    const c = JSON.parse(json);
    expect(c.object).toBe('chat.completion');
    expect(c.id).toBe('chatcmpl-test');
    expect(c.model).toBe('test-model');
    expect(c.choices[0].message.role).toBe('assistant');
    expect(c.choices[0].message.content).toBe('你好');
    expect(c.choices[0].finish_reason).toBe('stop');
    expect(c.usage).toBeUndefined();
  });

  it('reasoning_content：拼接为 message.reasoning_content', async () => {
    const json = await aggregateSseToJson(sseStream([
      chunk({ role: 'assistant' }),
      chunk({ reasoning_content: '思考' }),
      chunk({ reasoning_content: '过程' }),
      chunk({ content: '答案' }, 'stop'),
      'data: [DONE]\n\n',
    ]));
    const c = JSON.parse(json);
    expect(c.choices[0].message.reasoning_content).toBe('思考过程');
    expect(c.choices[0].message.content).toBe('答案');
  });

  it('tool_calls 分片合并：同 index 的 arguments 拼接', async () => {
    const json = await aggregateSseToJson(sseStream([
      chunk({ role: 'assistant' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"ci' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ty":"Beijing"}' } }] }),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ]));
    const c = JSON.parse(json);
    const tc = c.choices[0].message.tool_calls;
    expect(tc).toHaveLength(1);
    expect(tc[0].id).toBe('call_1');
    expect(tc[0].function.name).toBe('get_weather');
    expect(tc[0].function.arguments).toBe('{"city":"Beijing"}');
    expect(tc[0].index).toBeUndefined(); // 最终响应不含 index
  });

  it('usage 独立末帧（choices 为空）：被捕获', async () => {
    const json = await aggregateSseToJson(sseStream([
      chunk({ role: 'assistant' }),
      chunk({ content: 'hi' }, 'stop'),
      `data: ${JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1791900000, model: 'test-model',
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\n`,
      'data: [DONE]\n\n',
    ]));
    const c = JSON.parse(json);
    expect(c.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('usage 挂在内容帧上：同样被捕获', async () => {
    const json = await aggregateSseToJson(sseStream([
      chunk({ role: 'assistant', content: 'x' }, 'stop', { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      'data: [DONE]\n\n',
    ]));
    const c = JSON.parse(json);
    expect(c.usage).toEqual({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  });

  it('空流 / 只有 [DONE] → 抛错', async () => {
    await expect(aggregateSseToJson(sseStream([]))).rejects.toThrow('聚合失败');
    await expect(aggregateSseToJson(sseStream(['data: [DONE]\n\n']))).rejects.toThrow('聚合失败');
  });

  it('跨块拆分的帧（网络分片）也能正确拼接', async () => {
    /* 一帧被拆在两个 chunk 里——聚合器须缓冲到 \n\n 才解析。 */
    const full = chunk({ content: '你好' }, 'stop') + 'data: [DONE]\n\n';
    const enc = new TextEncoder();
    const mid = Math.floor(full.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(full.slice(0, mid)));
        c.enqueue(enc.encode(full.slice(mid)));
        c.close();
      },
    });
    const json = await aggregateSseToJson(stream);
    const parsed = JSON.parse(json);
    expect(parsed.choices[0].message.content).toBe('你好');
  });

  it('非 JSON 帧（上游杂音）被跳过，不影响聚合', async () => {
    const json = await aggregateSseToJson(sseStream([
      ': ping\n\n',
      chunk({ role: 'assistant', content: 'ok' }, 'stop'),
      'event: unknown\ndata: not-json\n\n',
      'data: [DONE]\n\n',
    ]));
    const c = JSON.parse(json);
    expect(c.choices[0].message.content).toBe('ok');
  });
});
