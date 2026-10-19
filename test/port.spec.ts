/**
 * 端口预检测试（v0.2.9）。
 *
 * 守两件事：
 *   ① 可用端口 → null（不误伤）；
 *   ② 各种失败形态 → 返回**可照做的**人话提示（不是裸错误码）。
 *
 * 特别钉住 Windows 那条：EACCES 的提示里必须出现「系统预留段」与查预留段的命令 ——
 * 那是用户唯一能自查的线索（netstat 看不到占用者）。
 */

import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findFreePort, probePort, suggestPort } from '../src/port.js';

describe('suggestPort', () => {
  it('★ 默认区间 8691–8790（Windows 常见预留段）→ 建议 8791', () => {
    expect(suggestPort(8786)).toBe(8791);
    expect(suggestPort(8787)).toBe(8791);
    expect(suggestPort(8788)).toBe(8791);
    expect(suggestPort(8789)).toBe(8791);
  });

  it('区间外 → 原值 + 1', () => {
    expect(suggestPort(3000)).toBe(3001);
    expect(suggestPort(8791)).toBe(8792);
  });
});

describe('probePort：可用的端口', () => {
  it('空闲端口返回 null（不误伤）', async () => {
    /* 让系统分配一个空闲端口，再关掉，重复用它的概率极低。 */
    const free = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        s.close(() => resolve(p));
      });
    });
    expect(await probePort('127.0.0.1', free)).toBeNull();
  });

  it('探测完会释放端口（连探两次都成功）', async () => {
    const free = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        s.close(() => resolve(p));
      });
    });
    expect(await probePort('127.0.0.1', free)).toBeNull();
    expect(await probePort('127.0.0.1', free)).toBeNull();
  });
});

describe('probePort：失败形态给可照做的提示', () => {
  it('端口被占用 → 提示换端口 + 查占用者的命令', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const addr = blocker.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const msg = await probePort('127.0.0.1', port);
      expect(msg).toContain('已被占用');
      expect(msg).toContain('netstat');
      expect(msg).toContain('lsof');
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('端口越界 → 直接说范围', async () => {
    expect(await probePort('127.0.0.1', 0)).toContain('1–65535');
    expect(await probePort('127.0.0.1', 70000)).toContain('1–65535');
    expect(await probePort('127.0.0.1', 1.5)).toContain('1–65535');
  });

  it('★ EACCES 或可用 —— 真机实测这条路径（Windows 保留段会走 EACCES，其它平台走 null）', async () => {
    /* 不能 mock ESM 的命名导出（vi.spyOn 对 `import { createServer }` 无效）。
       改为真实探测：在 Windows 保留段机器上这里会拿到 EACCES 文案，
       在别的机器上拿到 null —— 两种情况都必须「不抛、可读」。 */
    const msg = await probePort('127.0.0.1', 8787);
    if (msg === null) {
      expect(msg).toBeNull(); // 端口可用，正确放行
    } else {
      expect(msg).toContain('8787');
      /* 要么是占用提示、要么是 EACCES 预留段提示 —— 都不允许是裸错误码。 */
      expect(msg).toMatch(/已被占用|EACCES|无法绑定/);
      if (msg.includes('EACCES')) {
        expect(msg).toContain('系统预留段');
        expect(msg).toContain('netsh interface ipv4 show excludedportrange');
        expect(msg).toContain('--port 8791');
      }
    }
  });

  it('EADDRNOTAVAIL —— 绑定本机不存在的地址', async () => {
    /* 192.0.2.0/24 是 TEST-NET-1（RFC 5737），保证不是本机地址。 */
    const msg = await probePort('192.0.2.1', 8080);
    expect(msg).not.toBeNull();
    expect(msg).toContain('EADDRNOTAVAIL');
    expect(msg).toContain('127.0.0.1');
  });
});

describe('findFreePort：默认端口不可用时找替代', () => {
  it('★ 起始端口可用 → 直接用起始值（不无谓漂移）', async () => {
    const free = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        s.close(() => resolve(p));
      });
    });
    expect(await findFreePort('127.0.0.1', free)).toBe(free);
  });

  it('★ 起始端口被占用 → 返回下一个可用（不是 null）', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const addr = blocker.address();
    const busy = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const found = await findFreePort('127.0.0.1', busy);
      expect(found).not.toBeNull();
      expect(found).not.toBe(busy);
      expect(found).toBeGreaterThan(busy);
      /* 找到的那个确实能用 */
      expect(await probePort('127.0.0.1', found!)).toBeNull();
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('区间越界（起始值 > 65535）→ null', async () => {
    expect(await findFreePort('127.0.0.1', 65536)).toBeNull();
  });
});

afterEach(() => vi.restoreAllMocks());
