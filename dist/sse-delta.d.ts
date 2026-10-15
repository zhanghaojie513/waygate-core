/**
 * SSE delta 空值归一化（2026-10-16）。
 *
 * ## 为什么需要（实测根因）
 * OpenAI 系上游网关的每个 delta 都**塞满全量字段**：思考帧是
 * `{"content":"","reasoning_content":"词"}`（一帧一词），答案帧是
 * `{"content":"词","reasoning_content":""}`，另加恒定的 `tool_calls:[]` / `refusal:""` 等空壳。
 * 而 DeepSeek 官方 API 等**规范形状从不发空字段**。
 *
 * 后果：ai-sdk 系客户端（ZCode 用 provider-utils）把夹在 reasoning 帧之间的**空
 * `content:""` 当作分段边界** → **每个词被拆成一段独立思考**，界面上一次回答堆出
 * 几十条「思考 · 持续了几秒」，且客户端记录的思考文本变成 `"The\n\n user\n\n keeps…"`。
 *
 * ## 处置
 * 转发前丢掉 delta 里的**无信息空值**（空串 / null / 空数组 / 空函数调用壳）。
 * - **无损**：空值不携带任何语义，任何客户端对「字段缺失」与「字段为空」本就该等价处理；
 * - **保真**：`id` / `model` / `object` / `created` / `usage` / `finish_reason`
 *   与非空 delta **原样保留**（不改模型名、不改内容）。
 *
 * 与 relay-station 的 `proxy/sse-stream.ts` 同源实现（那边是生产验证过的）。
 */
/** 空值判定：空串 / null / undefined / 空数组 / `{"name":"","arguments":""}` 空壳。 */
export declare function isNoopValue(v: unknown): boolean;
/** 归一化单个 chunk：`choices[].delta` 去空值；顶层字段一字不动。 */
export declare function normalizeChunkDelta<T>(chunk: T): T;
/**
 * 归一化 `data:` 行的载荷；非 JSON / 非注释行原样返回。
 *
 * ⚠️ **不丢弃帧** —— 只剥 delta 里的空值字段。relay-station 的生产实现就是这么做的
 * （那边验证过：剥掉空字段就足以让 ai-sdk 不再分段，无需丢帧）；
 * 擅自丢帧有风险：`{"delta":{},"finish_reason":"stop"}` 这类收尾帧的 delta 本就为空，
 * 但**必须转发**（否则客户端收不到结束原因）。
 */
export declare function normalizeSsePayload(payload: string): string;
/**
 * 把 SSE 字节流做一次「delta 去空值」后再放过。
 *
 * 逐行处理但**不改变分帧**：每个完整行立即下发（不攒批），非 `data:` 行（空行、
 * `event:`、注释心跳）原样透传 —— 客户端看到的时间节奏与上游一致。
 * 用 `TextDecoder` 增量解码，跨 chunk 的多字节字符边界不会破（SSE 是 UTF-8）。
 *
 * 返回真正的 `TransformStream<Uint8Array, Uint8Array>`（`readable` 与 `writable` 都在），
 * 可直接 `pipeThrough`，也可像测试那样手动写/读。
 */
export declare function createSseDeltaNormalizer(): TransformStream<Uint8Array, Uint8Array>;
