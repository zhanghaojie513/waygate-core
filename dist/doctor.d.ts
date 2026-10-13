/**
 * 自检（`doctor` 子命令）：把「为什么用不了」拆成可逐项排查的检查清单。
 *
 * 顺序按「用户能自己解决」靠前：端口占用 → 凭证 → 模型 → 上游连通。
 * 每项都给人话结论 + 下一步动作（不抛栈）。
 */
import type { Adapter } from './types.js';
export interface CheckResult {
    name: string;
    ok: boolean;
    detail: string;
}
/** 端口是否可用（能监听即视为可用）。 */
export declare function checkPortFree(host: string, port: number): Promise<CheckResult>;
/** 跑完整自检（适配器提供凭证/模型/上游项）。 */
export declare function runDoctor(adapter: Adapter, host: string, port: number): Promise<CheckResult[]>;
export declare function renderDoctor(results: CheckResult[]): string;
