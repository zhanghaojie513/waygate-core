/**
 * 端口预检（2026-10-19）。
 *
 * ## 为什么单独抽出来
 * 四个工具（qoc / mmcode / wb / waygate-open）都默认监听 87xx，而 **Windows 上
 * 8786–8789 常被系统预留段整段占住**（Hyper-V / WSL2 / Docker Desktop 向 usermode
 * 申请的排除区间，实测见到 `8691–8790`）。落在里面的端口 `bind` 恒 `EACCES`，
 * 而 `netstat` **看不到任何进程占用** —— 用户第一反应必然是「明明没人用啊」。
 *
 * 只抛 `listen EACCES` + 一屏堆栈，等于把排查成本全丢给用户。这里把三类失败
 * 翻译成能直接照做的提示，四个工具共用（改一处四家受益）。
 *
 * ## 与 doctor 的 checkPortFree 的关系
 * `doctor` 那版是自检项（返回 CheckResult，供表格展示）；本模块是**启动前闸**
 * （返回人话字符串，失败即退出）。两者探测方式相同，但用途与措辞不同，故分开。
 */
import { createServer } from 'node:net';
/** 常见可用端口的建议值（落在 Windows 默认保留段之外，且四家连着方便记）。 */
export function suggestPort(port) {
    /* 8786–8789 是四家的默认区间；若用户改过且撞上，也给一个「原值 + 1」之外的稳定建议。 */
    return port >= 8691 && port <= 8790 ? 8791 : port + 1;
}
/**
 * 试绑一次端口，判断能否监听。
 *
 * 探测完立刻关闭，不占用端口。任何错误都转成可读文案，**不抛异常**。
 */
export function probePort(host, port) {
    return new Promise((resolve) => {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            resolve(`端口不合法：${port}（应为 1–65535）`);
            return;
        }
        /* 通配绑定要按通配探测，否则会误判（例如 0.0.0.0 上已被占用，但 127.0.0.1 空闲）。 */
        const bindHost = host === '0.0.0.0' || host === '::' ? '0.0.0.0' : host;
        const probe = createServer();
        probe.unref();
        probe.once('error', (err) => {
            const next = suggestPort(port);
            switch (err.code) {
                case 'EADDRINUSE':
                    resolve(`端口 ${port} 已被占用。\n` +
                        `  · 换一个端口：--port ${next}\n` +
                        `  · 或找出占用者：\n` +
                        `      Windows   netstat -ano | findstr :${port}\n` +
                        `      macOS/Linux  lsof -i :${port}`);
                    return;
                case 'EACCES':
                    resolve(`端口 ${port} 无权绑定（EACCES）。\n` +
                        `  · 这通常不是「被某个程序占用」，而是该端口落在 **系统预留段**里 ——\n` +
                        `    Hyper-V / WSL2 / Docker Desktop 会向系统申请一段排除区间，\n` +
                        `    里面的端口普通进程一律绑不上，而 netstat 看不到任何占用者。\n` +
                        `  · 查看 Windows 的预留段（需管理员）：\n` +
                        `      netsh interface ipv4 show excludedportrange protocol=tcp\n` +
                        `  · 换一个不在预留段里的端口即可：--port ${next}`);
                    return;
                case 'EADDRNOTAVAIL':
                    resolve(`地址 ${host} 在本机不存在（EADDRNOTAVAIL）—— 换回 127.0.0.1，或用 --host 指定本机确实拥有的地址。`);
                    return;
                default:
                    resolve(`端口 ${port} 无法绑定：${err.code ? `${err.code} ` : ''}${err.message}`);
            }
        });
        probe.listen({ host: bindHost, port, exclusive: true }, () => {
            probe.close(() => resolve(null));
        });
    });
}
