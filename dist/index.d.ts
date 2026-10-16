/**
 * @waygate/core —— Waygate 家族共享骨架。
 *
 * 提供：本地反代 HTTP 服务、入站密钥、配置目录、启动输出、自检、统一 CLI，
 * 以及**出口协议**（OpenAI `/v1/chat/completions` 与 Anthropic `/v1/messages`
 * 两套形状，见 `anthropic.ts`）。
 * **上游**协议知识（凭证、翻译、模型清单）由各适配器仓库实现 `Adapter` 接口。
 */
export type { Adapter, ChatMessage, ChatRequestBody, CredentialStatus, ModelEntry, UpstreamCallResult, } from './types.js';
export { waygateHome, commandDir, resolveKey, generateKey, maskKey } from './config.js';
export { startServer, type ServeOptions, type RunningServer } from './server.js';
export { aggregateSseToJson } from './aggregate.js';
export { createSseDeltaNormalizer, normalizeChunkDelta, normalizeSsePayload, isNoopValue } from './sse-delta.js';
export { AnthropicStreamEncoder, anthropicErrorType, anthropicToOpenAiBody, flattenSystem, mapStopReason, newMessageId, openAiSseToAnthropicFrames, sseFrame, toAnthropicErrorBody, toAnthropicMessage, type AnthropicMessageParams, } from './anthropic.js';
export { fetchWithRetry, describeFetchError, type RetryOptions } from './retry.js';
export { renderReady, renderReadyJson, type ReadyReport } from './report.js';
export { runDoctor, renderDoctor, checkPortFree, type CheckResult } from './doctor.js';
export { runCli, parseArgs, helpText, type CliMeta, type ParsedArgs } from './cli.js';
