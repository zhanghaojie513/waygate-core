/**
 * 统一 CLI（两家命令共用这套子命令：serve / models / doctor / login）。
 *
 * 设计目标：**学一个会两个** —— `qoc` 与 `mmcode` 的子命令、参数完全一致，
 * 只有命令名不同。适配器只提供业务钩子（凭证/模型/聊天），CLI 由这里统一处理。
 */
import { maskKey } from './config.js';
import type { Adapter } from './types.js';
export interface CliMeta {
    /** 包版本（各仓 package.json 的 version）。 */
    version: string;
}
export interface ParsedArgs {
    command: 'serve' | 'models' | 'doctor' | 'login' | 'help';
    host: string;
    port?: number;
    key?: string;
    json: boolean;
    verbose: boolean;
}
export declare function parseArgs(argv: string[], adapter: Adapter): ParsedArgs;
export declare function helpText(adapter: Adapter): string;
/** 命令入口：适配器 + 版本 → 完整 CLI 行为。返回进程退出码。 */
export declare function runCli(adapter: Adapter, meta: CliMeta, argv?: string[]): Promise<number>;
export { maskKey };
