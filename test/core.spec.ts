/**
 * core 骨架测试：密钥管理、服务鉴权/路由/流、CLI 解析、自检。
 * 用最小假适配器，不碰任何真实上游。
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveKey, generateKey, maskKey, commandDir } from '../src/config.js';
import { startServer } from '../src/server.js';
import { parseArgs, helpText } from '../src/cli.js';
import { checkPortFree, runDoctor } from '../src/doctor.js';
import { renderReady } from '../src/report.js';
import type { Adapter, ChatRequestBody } from '../src/types.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'waygate-core-'));
  process.env.WAYGATE_HOME = home;
});
afterEach(() => {
  delete process.env.WAYGATE_HOME;
  rmSync(home, { recursive: true, force: true });
});

/** 最小假适配器：回一条固定 SSE。 */
function fakeAdapter(over: Partial<Adapter> = {}): Adapter {
  return {
    command: 'fake',
    displayName: 'Fake Upstream',
    defaultPort: 18901,
    upstreamLabel: 'https://upstream.test',
    credentialStatus: async () => ({ ok: true, detail: '已就绪' }),
    login: async () => {},
    listModels: async () => [{ id: 'model-a' }, { id: 'model-b', displayName: 'Model B' }],
    chat: async (body: ChatRequestBody) => ({
      status: 200,
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"model":"${body.model}"}\n\n`));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      }),
    }),
    ...over,
  };
}

describe('config：入站密钥', () => {
  it('首次生成并落盘，二次复用同一把', () => {
    const k1 = resolveKey('fake');
    expect(k1).toMatch(/^sk-fake-[0-9a-f]{32}$/);
    const k2 = resolveKey('fake');
    expect(k2).toBe(k1);
    expect(readFileSync(join(commandDir('fake'), 'key'), 'utf8').trim()).toBe(k1);
  });

  it('--key 覆盖优先且不落盘', () => {
    const k = resolveKey('fake', 'sk-explicit');
    expect(k).toBe('sk-explicit');
    expect(() => readFileSync(join(commandDir('fake'), 'key'), 'utf8')).toThrow();
  });

  it('maskKey 只留头尾', () => {
    expect(maskKey('sk-fake-0123456789abcdef0123456789abcdef')).toMatch(/^sk-fake-0123…cdef$/);
  });

  it('不同命令的密钥互不干扰', () => {
    expect(generateKey('qoc')).toMatch(/^sk-qoc-/);
    expect(resolveKey('qoc')).not.toBe(resolveKey('mmcode'));
  });
});

describe('server：鉴权与路由', () => {
  it('无密钥 → 401；错密钥 → 401；对密钥 → 通', async () => {
    const running = await startServer(fakeAdapter(), { host: '127.0.0.1', port: 0, apiKey: 'sk-test' });
    const base = `http://127.0.0.1:${running.port}`;
    try {
      const noKey = await fetch(`${base}/v1/models`);
      expect(noKey.status).toBe(401);

      const badKey = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer nope' } });
      expect(badKey.status).toBe(401);

      const ok = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-test' } });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { data: Array<{ id: string }> };
      expect(body.data.map((m) => m.id)).toEqual(['model-a', 'model-b']);
    } finally {
      await running.close();
    }
  });

  it('x-api-key 头也认（Anthropic 客户端形态）', async () => {
    const running = await startServer(fakeAdapter(), { host: '127.0.0.1', port: 0, apiKey: 'sk-test' });
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': 'sk-test', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      expect(text).toContain('model-a');
      expect(text).toContain('[DONE]');
    } finally {
      await running.close();
    }
  });

  it('healthz 无需鉴权', async () => {
    const running = await startServer(fakeAdapter(), { host: '127.0.0.1', port: 0, apiKey: 'sk-test' });
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/healthz`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    } finally {
      await running.close();
    }
  });

  it('缺 model / messages → 400', async () => {
    const running = await startServer(fakeAdapter(), { host: '127.0.0.1', port: 0, apiKey: 'sk-test' });
    const h = { authorization: 'Bearer sk-test', 'content-type': 'application/json' };
    try {
      const base = `http://127.0.0.1:${running.port}`;
      expect((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: h, body: '{}' })).status).toBe(400);
      expect(
        (await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: h, body: JSON.stringify({ model: 'm', messages: [] }) })).status,
      ).toBe(400);
    } finally {
      await running.close();
    }
  });

  it('适配器抛错 → 502 且是 OpenAI 形状错误体', async () => {
    const running = await startServer(
      fakeAdapter({ chat: async () => { throw new Error('上游炸了'); } }),
      { host: '127.0.0.1', port: 0, apiKey: 'sk-test' },
    );
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain('上游炸了');
    } finally {
      await running.close();
    }
  });
});

describe('cli：参数解析与帮助', () => {
  const a = fakeAdapter();
  it('默认 serve + 默认监听回环与默认端口', () => {
    const p = parseArgs([], a);
    expect(p.command).toBe('serve');
    expect(p.host).toBe('127.0.0.1');
    expect(p.port).toBeUndefined();
  });
  it('识别四个子命令', () => {
    expect(parseArgs(['models'], a).command).toBe('models');
    expect(parseArgs(['doctor'], a).command).toBe('doctor');
    expect(parseArgs(['login'], a).command).toBe('login');
    expect(parseArgs(['--help'], a).command).toBe('help');
  });
  it('--port 校验范围；非法值抛错', () => {
    expect(parseArgs(['--port', '9000'], a).port).toBe(9000);
    expect(() => parseArgs(['--port', '99999'], a)).toThrow();
    expect(() => parseArgs(['--port', 'abc'], a)).toThrow();
  });
  it('未知参数抛错（不静默忽略）', () => {
    expect(() => parseArgs(['--wat'], a)).toThrow();
  });
  it('帮助里含全部子命令与命令名', () => {
    const h = helpText(a);
    for (const c of ['serve', 'models', 'doctor', 'login']) expect(h).toContain(c);
    expect(h).toContain('fake');
  });
});

describe('doctor', () => {
  it('端口可用检测：占用时报不可用且给下一步', async () => {
    const running = await startServer(fakeAdapter(), { host: '127.0.0.1', port: 0, apiKey: 'k' });
    try {
      const r = await checkPortFree('127.0.0.1', running.port);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('--port');
    } finally {
      await running.close();
    }
  });

  it('凭证未就绪时跳过模型检查', async () => {
    const a = fakeAdapter({ credentialStatus: async () => ({ ok: false, detail: '未导入' }) });
    const results = await runDoctor(a, '127.0.0.1', 18902);
    expect(results.find((r) => r.name === '凭证')?.ok).toBe(false);
    expect(results.find((r) => r.name === '模型清单')).toBeUndefined();
  });
});

describe('report', () => {
  it('回环地址渲染为可复制的 http URL，并列出模型 ID', () => {
    const text = renderReady({
      command: 'fake', displayName: 'Fake', version: '0.1.0', upstream: 'https://u.test',
      host: '127.0.0.1', port: 18901, key: 'sk-fake-0123456789abcdef0123456789abcdef',
      credential: { ok: true, detail: '已就绪' },
      models: [{ id: 'model-a' }, { id: 'model-b', displayName: 'Model B' }],
    });
    expect(text).toContain('http://127.0.0.1:18901');
    expect(text).toContain('model-a');
    expect(text).toContain('Model B');
    /* 密钥必须**完整**显示 —— 它就是要给用户复制进客户端的，打码则不可用。 */
    expect(text).toContain('sk-fake-0123456789abcdef0123456789abcdef');
  });

  it('0.0.0.0 时打印局域网暴露警告', () => {
    const text = renderReady({
      command: 'fake', displayName: 'Fake', version: '0.1.0', upstream: 'https://u.test',
      host: '0.0.0.0', port: 1, key: 'k', credential: { ok: true, detail: '' }, models: [],
    });
    expect(text).toContain('局域网');
  });
});

describe('server：路径兼容（/v1 前缀可带可不带）', () => {
  it('四种组合都通：{带,不带}/v1 × {models, chat}', async () => {
    const running = await startServer(fakeAdapter(), { host: '127.0.0.1', port: 0, apiKey: 'sk-t' });
    const base = `http://127.0.0.1:${running.port}`;
    const h = { authorization: 'Bearer sk-t', 'content-type': 'application/json' };
    const body = JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] });
    try {
      expect((await fetch(`${base}/v1/models`, { headers: h })).status).toBe(200);
      expect((await fetch(`${base}/models`, { headers: h })).status).toBe(200);
      expect((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: h, body })).status).toBe(200);
      expect((await fetch(`${base}/chat/completions`, { method: 'POST', headers: h, body })).status).toBe(200);
      expect((await fetch(`${base}/v1/messages`, { method: 'POST', headers: h, body })).status).toBe(200);
      expect((await fetch(`${base}/messages`, { method: 'POST', headers: h, body })).status).toBe(200);
    } finally {
      await running.close();
    }
  });

  it('真正未知的路径仍 404（兼容不等于全放行）', async () => {
    const running = await startServer(fakeAdapter(), { host: '127.0.0.1', port: 0, apiKey: 'sk-t' });
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/v1/nope`, { headers: { authorization: 'Bearer sk-t' } });
      expect(res.status).toBe(404);
    } finally {
      await running.close();
    }
  });
});
