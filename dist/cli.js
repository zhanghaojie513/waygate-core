/**
 * 统一 CLI（两家命令共用这套子命令：serve / models / doctor / login）。
 *
 * 设计目标：**学一个会两个** —— `qoc` 与 `mmcode` 的子命令、参数完全一致，
 * 只有命令名不同。适配器只提供业务钩子（凭证/模型/聊天），CLI 由这里统一处理。
 */
import { resolveKey, maskKey } from './config.js';
import { runDoctor, renderDoctor } from './doctor.js';
import { findFreePort, probePort, suggestPort } from './port.js';
import { renderReady, renderReadyJson } from './report.js';
import { startServer } from './server.js';
const BUILTIN = ['serve', 'models', 'doctor', 'login', 'help', '--help', '-h'];
export function parseArgs(argv, adapter) {
    const args = [...argv];
    const known = new Set([...BUILTIN, ...(adapter.extraCommands ?? []).map((c) => c.name)]);
    let command = 'serve';
    if (args[0] && known.has(args[0])) {
        const c = args.shift();
        command = c === '--help' || c === '-h' ? 'help' : c;
    }
    let host = '127.0.0.1';
    let port;
    let key;
    let json = false;
    let verbose = false;
    const rest = [];
    for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a === undefined)
            break;
        if (a === '--host')
            host = args[++i] ?? host;
        else if (a === '--port') {
            const v = Number(args[++i]);
            if (!Number.isInteger(v) || v < 1 || v > 65535)
                throw new Error(`--port 非法：${args[i]}`);
            port = v;
        }
        else if (a === '--key')
            key = args[++i];
        else if (a === '--json')
            json = true;
        else if (a === '--verbose')
            verbose = true;
        else if (a === '--help' || a === '-h')
            command = 'help';
        else if (a.startsWith('-'))
            throw new Error(`未知参数：${a}（用 --help 看用法）`);
        else
            rest.push(a); /* 自定义子命令的位置参数（如 checkin --all） */
    }
    return { command, host, port, key, json, verbose, rest };
}
export function helpText(adapter) {
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
export async function runCli(adapter, meta, argv = process.argv.slice(2)) {
    let parsed;
    try {
        parsed = parseArgs(argv, adapter);
    }
    catch (err) {
        process.stderr.write(`${err.message}\n`);
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
            if (out)
                process.stdout.write(out.endsWith('\n') ? out : out + '\n');
            return 0;
        }
        catch (err) {
            process.stderr.write(`${extra.name} 失败：${err.message}\n`);
            return 1;
        }
    }
    if (parsed.command === 'login') {
        try {
            await adapter.login();
            const cred = await adapter.credentialStatus();
            process.stdout.write(`凭证    ${cred.ok ? '✓' : '✗'} ${cred.detail}\n`);
            return cred.ok ? 0 : 1;
        }
        catch (err) {
            process.stderr.write(`登录态导入失败：${err.message}\n`);
            return 1;
        }
    }
    const host = parsed.host;
    let port = parsed.port ?? adapter.defaultPort;
    /** 是否发生了自动改端口（用于在启动输出里如实告知）。 */
    let autoPortFrom = null;
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
        }
        else {
            for (const m of models)
                process.stdout.write(`${m.id}${m.displayName && m.displayName !== m.id ? '   ' + m.displayName : ''}\n`);
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
    /* 端口预检（v0.2.9）：先探一次再起服务，把 EACCES / EADDRINUSE 翻译成能照做的提示。
       Windows 上 8786–8789 常被系统预留段整段占住（Hyper-V / WSL / Docker），
       那种情况 netstat 看不到占用者，只抛堆栈用户无从下手。
  
       [v0.2.10] 若用户**没显式指定 --port**，默认端口不可用时自动往后找一个能用的
       ——「装完直接敲命令就能跑」是本地工具的底线，不该逼用户先查系统预留段。
       用户显式给了 --port 却绑不上时**不自动改**（部署脚本可能固定端口），原样报错。 */
    const portProblem = await probePort(host, port);
    if (portProblem) {
        if (parsed.port !== undefined) {
            process.stderr.write(`${portProblem}\n`);
            return 1;
        }
        const fallback = await findFreePort(host, suggestPort(port));
        if (fallback === null) {
            process.stderr.write(`${portProblem}\n`);
            return 1;
        }
        autoPortFrom = port;
        port = fallback;
    }
    /* 自动改端口时如实告知（不静默）—— 用户要知道「为什么不是默认那个」。 */
    if (autoPortFrom !== null && !parsed.json) {
        process.stderr.write(`默认端口 ${autoPortFrom} 在本机不可用（多半是 Windows 系统预留段），已自动改用 ${port}。\n` +
            `  · 想固定下来：加 \`--port ${port}\`，或查预留段：netsh interface ipv4 show excludedportrange protocol=tcp\n`);
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
        return await new Promise(() => {
            /* 常驻：直到信号触发 exit */
        });
    }
    catch (err) {
        const e = err;
        /* 预检已覆盖 EACCES / EADDRINUSE。这里只剩「预检通过、真正 listen 时被抢」的竞态，
           以及其它启动失败 —— 仍按端口类错误给人话提示，其余显示原始信息。 */
        if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
            const again = await probePort(host, port);
            if (again) {
                process.stderr.write(`${again}\n`);
                return 1;
            }
        }
        process.stderr.write(`启动失败：${e.message}\n`);
        return 1;
    }
}
export { maskKey };
