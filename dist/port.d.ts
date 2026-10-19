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
/** 试绑结果：null = 可用；字符串 = 给人看的失败说明。 */
export type PortProblem = string | null;
/** 常见可用端口的建议值（落在 Windows 默认保留段之外，且四家连着方便记）。 */
export declare function suggestPort(port: number): number;
/**
 * 默认端口不可用时，找下一个能用的。
 *
 * **只用于「用户没显式指定 --port」的情形** —— 用户明确指定了端口却绑不上，
 * 必须原样报错（他可能是在部署脚本里固定端口），不能悄悄换。
 *
 * 从 `suggestPort(start)` 起往后探，最多 `AUTO_PORT_SCAN` 个；全都不行返回 null。
 */
export declare function findFreePort(host: string, start: number): Promise<number | null>;
/**
 * 试绑一次端口，判断能否监听。
 *
 * 探测完立刻关闭，不占用端口。任何错误都转成可读文案，**不抛异常**。
 */
export declare function probePort(host: string, port: number): Promise<PortProblem>;
