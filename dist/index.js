/**
 * @waygate/core —— Waygate 家族共享骨架。
 *
 * 提供：本地反代 HTTP 服务、入站密钥、配置目录、启动输出、自检、统一 CLI。
 * 上游协议知识（凭证、翻译、模型清单）由各适配器仓库实现 `Adapter` 接口。
 */
export { waygateHome, commandDir, resolveKey, generateKey, maskKey } from './config.js';
export { startServer } from './server.js';
export { aggregateSseToJson } from './aggregate.js';
export { renderReady, renderReadyJson } from './report.js';
export { runDoctor, renderDoctor, checkPortFree } from './doctor.js';
export { runCli, parseArgs, helpText } from './cli.js';
