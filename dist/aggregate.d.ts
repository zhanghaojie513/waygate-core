/**
 * SSE 聚合器：把 OpenAI 形状的 SSE chunk 流拼成单个 `chat.completion` JSON。
 *
 * 用于 `stream: false` 的入站请求 —— 上游恒走流式（两家协议如此），代理在出口把
 * 流聚合成非流式响应返回给客户端。这是 OpenAI 规范的要求：`stream:false` 应返回
 * 单个 JSON 而非 SSE。
 *
 * 聚合规则（只认真实出现的字段，不编造）：
 *   · `choices[0].delta.content` 拼接为 `message.content`
 *   · `choices[0].delta.reasoning_content` 拼接为 `message.reasoning_content`（DeepSeek 惯例）
 *   · `choices[0].delta.role` 取首个非空值
 *   · `choices[0].delta.tool_calls` 累积（按 index 合并 arguments 分片）
 *   · `finish_reason` 取最后一个非空值
 *   · `usage` 取末帧（含 `stream_options.include_usage` 的独立末帧）
 *   · `id` / `model` / `created` 取首个 chunk 的值
 */
/**
 * 聚合一整个 SSE 流为单个 completion 对象。
 * 输入是 OpenAI SSE 字节流（与流式透传相同格式），输出是 JSON 字符串。
 *
 * @throws 如果流内不含任何有效 chunk（上游异常）
 */
export declare function aggregateSseToJson(stream: ReadableStream<Uint8Array>): Promise<string>;
