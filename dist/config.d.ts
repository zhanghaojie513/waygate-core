/**
 * 配置目录与入站密钥管理。
 *
 * 配置落在用户主目录下的 `.waygate/`（跨平台）：
 *   ~/.waygate/<command>/           每家一个子目录（qoc / mmcode 互不干扰）
 *   ~/.waygate/<command>/key        入站密钥（sk-<command>-…，0600）
 *   ~/.waygate/<command>/credential.json   适配器自管的凭证副本（可选）
 *
 * 为什么密钥要落盘：客户端（Cursor / Claude Code 等）只接受**稳定的**密钥串；
 * 每次启动随机生成会让用户在客户端里反复改配置。落盘一次、后续复用。
 */
/** 家族配置根目录（`~/.waygate`）。可用 WAYGATE_HOME 覆盖（测试/便携部署用）。 */
export declare function waygateHome(): string;
/** 某家命令的配置目录（`~/.waygate/<command>`），确保存在。 */
export declare function commandDir(command: string): string;
/** 入站密钥的落盘形态：`sk-<command>-<32hex>`。 */
export declare function generateKey(command: string): string;
/**
 * 取该命令的入站密钥：已落盘则复用，否则生成并落盘（0600）。
 * `override`（CLI `--key`）优先，不落盘 —— 用户显式指定即由用户自管。
 */
export declare function resolveKey(command: string, override?: string): string;
/** 打印用：密钥打码（只留头尾）。 */
export declare function maskKey(key: string): string;
