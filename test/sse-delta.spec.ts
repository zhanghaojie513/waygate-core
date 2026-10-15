/**
 * SSE delta 空值归一化测试。
 *
 * 守的是**实测过的客户端症状**：上游思考帧形如
 * `{"content":"","reasoning_content":"词"}`，ai-sdk 系客户端（ZCode）把其中的空
 * `content:""` 当分段边界 → 一次回答堆出几十条「思考」。剥掉空值即修复。
 */

import { describe, expect, it } from 'vitest';
import { isNoopValue, normalizeChunkDelta, normalizeSsePayload, createSseDeltaNormalizer } from '../src/sse-delta.js';

describe('isNoopValue', () => {
  it('空串 / null / undefined / 空数组 = 无信息', () => {
    expect(isNoopValue('')).toBe(true);
    expect(isNoopValue(null)).toBe(true);
    expect(isNoopValue(undefined)).toBe(true);
    expect(isNoopValue([])).toBe(true);
  });

  it('function_call 空壳 = 无信息', () => {
    expect(isNoopValue({ name: '', arguments: '' })).toBe(true);
  });

  it('有内容的字段不是空值', () => {
    expect(isNoopValue('词')).toBe(false);
    expect(isNoopValue(0)).toBe(false);
    expect(isNoopValue(false)).toBe(false);
    expect(isNoopValue([1])).toBe(false);
    expect(isNoopValue({ name: 'f', arguments: '{}' })).toBe(false);
  });
});

describe('normalizeChunkDelta', () => {
  it('★ 思考帧：剥掉 content:""，保留 reasoning_content（这是修 N 次思考的关键）', () => {
    const chunk = {
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta: { content: '', reasoning_content: 'The' }, finish_reason: null }],
    };
    const out = normalizeChunkDelta(chunk) as typeof chunk;
    expect(out.choices[0]!.delta).toEqual({ reasoning_content: 'The' });
    /* 顶层字段一字不动（保真：不改 id/model/created）。 */
    expect(out.id).toBe('c1');
    expect(out.model).toBe('m');
    expect(out.object).toBe('chat.completion.chunk');
  });

  it('★ 答案帧：剥掉 reasoning_content:""，保留 content', () => {
    const chunk = {
      choices: [{ index: 0, delta: { content: '你好', reasoning_content: '' }, finish_reason: null }],
    };
    const out = normalizeChunkDelta(chunk) as typeof chunk;
    expect(out.choices[0]!.delta).toEqual({ content: '你好' });
  });

  it('★ 收尾帧必须原样保留（delta 空但 finish_reason 是信息）', () => {
    const chunk = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    const out = normalizeChunkDelta(chunk) as typeof chunk;
    expect(out.choices[0]!.finish_reason).toBe('stop');
  });

  it('usage 帧（choices 为空）不受影响', () => {
    const chunk = { choices: [], usage: { total_tokens: 5 } };
    expect(normalizeChunkDelta(chunk)).toEqual(chunk);
  });

  it('无空值时返回原对象引用（不做无谓拷贝）', () => {
    const chunk = { choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] };
    expect(normalizeChunkDelta(chunk)).toBe(chunk);
  });
});

describe('normalizeSsePayload', () => {
  it('data 载荷里的空值被剥掉', () => {
    const src = JSON.stringify({ choices: [{ index: 0, delta: { content: '', reasoning_content: 'a' } }] });
    const out = normalizeSsePayload(src);
    expect(out).not.toContain('"content":""');
    expect(out).toContain('"reasoning_content":"a"');
  });

  it('[DONE] 与非 JSON 行原样返回（不误伤心跳/注释）', () => {
    expect(normalizeSsePayload('[DONE]')).toBe('[DONE]');
    expect(normalizeSsePayload(': keepalive')).toBe(': keepalive');
    expect(normalizeSsePayload('')).toBe('');
  });

  it('坏 JSON 原样透传（不因一帧坏掉就断流）', () => {
    const bad = '{"choices":[';
    expect(normalizeSsePayload(bad)).toBe(bad);
  });
});

describe('createSseDeltaNormalizer（整条流）', () => {
  async function run(parts: string[]): Promise<string> {
    const ts = createSseDeltaNormalizer();
    const w = ts.writable.getWriter();
    const enc = new TextEncoder();
    const collected: string[] = [];
    const rd = ts.readable.getReader();
    const dec = new TextDecoder();
    const pump = (async () => {
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        collected.push(dec.decode(value, { stream: true }));
      }
    })();
    for (const p of parts) await w.write(enc.encode(p));
    await w.close();
    await pump;
    return collected.join('');
  }

  it('★ 端到端：一串思考帧 + 答案帧 + 收尾，空值全被剥离', async () => {
    const out = await run([
      'data: {"choices":[{"index":0,"delta":{"content":"","reasoning_content":"We"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"","reasoning_content":" need"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"好","reasoning_content":""},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    expect(out).not.toContain('"content":""');
    expect(out).not.toContain('"reasoning_content":""');
    expect(out).toContain('"reasoning_content":"We"');
    expect(out).toContain('"content":"好"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain('[DONE]');
  });

  it('★ 跨 chunk 截断的多字节字符与半行不破坏（UTF-8 边界）', async () => {
    const line = 'data: {"choices":[{"index":0,"delta":{"content":"中文词","reasoning_content":""},"finish_reason":null}]}\n\n';
    const bytes = new TextEncoder().encode(line);
    /* 故意在半个汉字处切开。 */
    const cut = 40;
    const out = await run([new TextDecoder().decode(bytes.slice(0, cut)), new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(cut))]);
    expect(out).toContain('中文词');
    expect(out).not.toContain('"reasoning_content":""');
  });

  it('非 data 行（空行/注释）原样保留', async () => {
    const out = await run([': ping\n\n', 'data: [DONE]\n\n']);
    expect(out).toContain(': ping');
    expect(out).toContain('[DONE]');
  });
});
