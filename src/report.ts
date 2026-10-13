/**
 * 启动输出（`serve` / `models` 共用）。
 *
 * 人读版：模型 ID + 代理地址 + 密钥，一屏内复制得走。
 * `--json`：同信息机器可读（给脚本/其他工具消费）。
 */

import type { CredentialStatus, ModelEntry } from './types.js';
import { maskKey } from './config.js';

export interface ReadyReport {
  command: string;
  displayName: string;
  version: string;
  adapterVersion?: string;
  upstream: string;
  host: string;
  port: number;
  key: string;
  credential: CredentialStatus;
  models: ModelEntry[];
}

/** 代理地址（回环时省略 scheme 中的主机歧义，直接用用户可复制的完整 URL）。 */
function baseUrl(host: string, port: number): string {
  const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${h}:${port}`;
}

export function renderReady(r: ReadyReport): string {
  const lines: string[] = [];
  lines.push(`途关 · ${r.displayName} 反代 v${r.version}`);
  lines.push('');
  lines.push(`凭证    ${r.credential.ok ? '✓' : '✗'} ${r.credential.detail}`);
  lines.push(`上游    ${r.upstream}`);
  lines.push(`代理    ${baseUrl(r.host, r.port)}`);
  lines.push(`密钥    ${maskKey(r.key)}`);
  if (r.host === '0.0.0.0' || r.host === '::') {
    lines.push('');
    lines.push(`⚠️  正在监听所有网络接口（${r.host}）—— 局域网内任何设备都能访问你的订阅。`);
    lines.push('    如非必要，请改用默认的 127.0.0.1。');
  }
  lines.push('');
  lines.push('模型 ID（填进你的客户端）：');
  if (r.models.length === 0) lines.push('  （暂无 —— 先跑一次 doctor 排查）');
  for (const m of r.models) {
    const hint = m.displayName && m.displayName !== m.id ? `   ${m.displayName}` : '';
    lines.push(`  ${m.id}${hint}`);
  }
  lines.push('');
  lines.push(`把上面的「代理地址 + 密钥」填进 Cursor / Claude Code / Cherry Studio 等客户端即可。`);
  lines.push('端点：POST /v1/chat/completions（OpenAI 兼容）· POST /v1/messages（Anthropic 兼容）· GET /v1/models');
  lines.push('按 Ctrl+C 停止。');
  return lines.join('\n');
}

export function renderReadyJson(r: ReadyReport): string {
  return JSON.stringify(
    {
      command: r.command,
      displayName: r.displayName,
      version: r.version,
      upstream: r.upstream,
      proxyUrl: baseUrl(r.host, r.port),
      key: r.key,
      credential: { ok: r.credential.ok, detail: r.credential.detail, source: r.credential.source ?? null },
      models: r.models.map((m) => ({ id: m.id, displayName: m.displayName ?? null })),
      endpoints: { openai: '/v1/chat/completions', anthropic: '/v1/messages', models: '/v1/models' },
    },
    null,
    2,
  );
}
