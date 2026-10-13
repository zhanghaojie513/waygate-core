/**
 * 启动输出（`serve` / `models` 共用）。
 *
 * 人读版：模型 ID + 代理地址 + 密钥，一屏内复制得走。
 * `--json`：同信息机器可读（给脚本/其他工具消费）。
 */
import type { CredentialStatus, ModelEntry } from './types.js';
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
export declare function renderReady(r: ReadyReport): string;
export declare function renderReadyJson(r: ReadyReport): string;
