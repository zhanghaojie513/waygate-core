/**
 * 统一 CLI（两家命令共用这套子命令：serve / models / doctor / login）。
 *
 * 设计目标：**学一个会两个** —— `qoc` 与 `mmcode` 的子命令、参数完全一致，
 * 只有命令名不同。适配器只提供业务钩子（凭证/模型/聊天），CLI 由这里统一处理。
 */

import { resolveKey, maskKey } from './config.js';
import { runDoctor, renderDoctor } from './doctor.js';
import { renderReady, renderReadyJson } from './report.js';
import { startServer } from './server.js';
import type { Adapter } from './types.js';

export interface CliMeta {
  /** 包版本（各仓 package.json 的 version）。 */
  version: string;
}

export interface ParsedArgs {
  /** 内置子命令，或适配器自定义子命令名。 */
  command: 'serve' | 'models' | 'doctor' | 'login' | 'help' | (string & {});
  host: string;
  port?: number;
  key?: string;
  json: boolean;
  verbose: boolean;
  /** 传给自定义子命令的剩余位置参数。 */
  rest: string[];
}

const BUILTIN = ['serve', 'models', 'doctor', 'login', 'help', '--help', '-h'] as const;

export function parseArgs(argv: string[], adapter: Adapter): ParsedArgs {
  const args = [...argv];
  const known = new Set<string>([...BUILTIN, ...(adapter.extraCommands ?? []).map((c) => c.name)]);
  let command: ParsedArgs['command'] = 'serve';
  if (args[0] && known.has(args[0])) {
    const c = args.shift()!;
    command = c === '--help' || c === '-h' ? 'help' : c;
  }

  let host = '127.0.0.1';
  let port: number | undefined;
  let key: string | undefined;
  let json = false;
  let verbose = false;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === undefined) break;
    if (a === '--host') host = args[++i] ?? host;
    else if (a === '--port') {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`--port 非法：${args[i]}`);
      port = v;
    } else if (a === '--key') key = args[++i];
    else if (a === '--json') json = true;
    else if (a === '--verbose') verbose = true;
    else if (a === '--help' || a === '-h') command = 'help';
    else if (a.startsWith('-')) throw new Error(`未知参数：${a}（用 --help 看用法）`);
    else rest.push(a); /* 自定义子命令的位置参数（如 checkin --all） */
  }
  return { command, host, port, key, json, verbose, rest };
}

export function helpText(adapter: Adapter): string {
  const c = adapter.command;
  return [
    `途关 · ${adapter.displayName} 反代（命令 ${c}）`,
    '',
    '用法：',
    `  ${c}                 启动反代（同 ${c} serve），打印模型 ID 与代理地址`,
    `  ${c} serve           同上`,
    `  ${c} models          只列出模型 ID（不起服务）`,
    `  ${c} doctor          自检：端口 / 凭证 / 模型 / 上游连通`,
    `  ${c} login           ${adapter.loginHint ?? `导入或刷新本机 ${adapter.displayName} 客户端的登录态`}`,
    ...(adapter.extraCommands?.length
      ? ['', `${adapter.displayName} 专属：`, ...adapter.extraCommands.map((x) => `  ${c} ${x.usage.padEnd(17)}${x.summary}`)]
      : []),
    '',
    '参数：',
    '  --port <n>          监听端口（默认 ' + adapter.defaultPort + '）',
    '  --host <addr>       监听地址（默认 127.0.0.1；0.0.0.0 会暴露给局域网，谨慎）',
    '  --key <sk-…>        指定入站密钥（默认自动生成并缓存到 ~/.waygate/' + c + '/key）',
    '  --json              机器可读输出',
    '  --verbose           打印每个请求的路由日志',
    '  --help              显示本帮助',
    '',
    '只在你本机读写与转发；不上传任何数据。',
  ].join('\n');
}

/** 命令入口：适配器 + 版本 → 完整 CLI 行为。返回进程退出码。 */
export async function runCli(adapter: Adapter, meta: CliMeta, argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv, adapter);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  if (parsed.command === 'help') {
    process.stdout.write(helpText(adapter) + '\n');
    return 0;
  }

  /* 适配器自定义子命令（如 mmcode 的 checkin / credits）。 */
  const extra = adapter.extraCommands?.find((x) => x.name === parsed.command);
  if (extra) {
    try {
      const out = await extra.run({ json: parsed.json, args: parsed.rest });
      if (out) process.stdout.write(out.endsWith('\n') ? out : out + '\n');
      return 0;
    } catch (err) {
      process.stderr.write(`${extra.name} 失败：${(err as Error).message}\n`);
      return 1;
    }
  }

  if (parsed.command === 'login') {
    try {
      await adapter.login();
      const cred = await adapter.credentialStatus();
      process.stdout.write(`凭证    ${cred.ok ? '✓' : '✗'} ${cred.detail}\n`);
      return cred.ok ? 0 : 1;
    } catch (err) {
      process.stderr.write(`登录态导入失败：${(err as Error).message}\n`);
      return 1;
    }
  }

  const host = parsed.host;
  const port = parsed.port ?? adapter.defaultPort;

  if (parsed.command === 'doctor') {
    const results = await runDoctor(adapter, host, port);
    process.stdout.write(renderDoctor(results) + '\n');
    return results.every((r) => r.ok) ? 0 : 1;
  }

  const key = resolveKey(adapter.command, parsed.key);
  const cred = await adapter.credentialStatus();
  const models = await adapter.listModels().catch(() => []);

  if (parsed.command === 'models') {
    if (parsed.json) {
      process.stdout.write(JSON.stringify({ models: models.map((m) => ({ id: m.id, displayName: m.displayName ?? null })) }, null, 2) + '\n');
    } else {
      for (const m of models) process.stdout.write(`${m.id}${m.displayName && m.displayName !== m.id ? '   ' + m.displayName : ''}\n`);
    }
    return models.length > 0 ? 0 : 1;
  }

  /* serve */
  const ready = {
    command: adapter.command,
    displayName: adapter.displayName,
    version: meta.version,
    upstream: adapter.upstreamLabel,
    host,
    port,
    key,
    credential: cred,
    models,
  };

  if (!cred.ok && !parsed.json) {
    process.stderr.write(`凭证未就绪：${cred.detail}\n先运行：${adapter.command} login\n`);
  }

  try {
    const running = await startServer(adapter, {
      host,
      port,
      apiKey: key,
      verbose: parsed.verbose,
      log: (line) => process.stdout.write(line + '\n'),
    });

  process.stdout.write((parsed.json ? renderReadyJson({ ...ready, port: running.port }) : renderReady({ ...ready, port: running.port })) + '\n');

    const shutdown = () => {
      process.stdout.write('\n正在停止…\n');
      void running.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return await new Promise<number>(() => {
      /* 常驻：直到信号触发 exit */
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') {
      process.stderr.write(`端口 ${port} 已被占用 —— 换一个：${adapter.command} --port ${port + 1}\n`);
      return 1;
    }
    process.stderr.write(`启动失败：${e.message}\n`);
    return 1;
  }
}

export { maskKey };
