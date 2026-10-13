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
export async function aggregateSseToJson(stream) {
    const decoder = new TextDecoder();
    const agg = { content: '' };
    let finish = null;
    let usage;
    let id = '';
    let model = '';
    let created = 0;
    let sawChunk = false;
    const reader = stream.getReader();
    try {
        let buf = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buf += decoder.decode(value, { stream: true });
            /* SSE 帧按 \n\n 分隔；最后一段可能不完整（等下一块）。 */
            const frames = buf.split('\n\n');
            buf = frames.pop() ?? '';
            for (const frame of frames) {
                const dataLine = frame
                    .split('\n')
                    .find((l) => l.startsWith('data:'));
                if (!dataLine)
                    continue;
                const payload = dataLine.slice(5).trim();
                if (!payload || payload === '[DONE]')
                    continue;
                let chunk;
                try {
                    chunk = JSON.parse(payload);
                }
                catch {
                    continue; /* 非 JSON 帧（上游杂音），跳过 */
                }
                sawChunk = true;
                if (!id && typeof chunk.id === 'string')
                    id = chunk.id;
                if (!model && typeof chunk.model === 'string')
                    model = chunk.model;
                if (!created && typeof chunk.created === 'number')
                    created = chunk.created;
                /* usage 独立末帧（choices 为空）或挂在内容帧上 —— 都取。 */
                const u = chunk.usage;
                if (u && typeof u === 'object')
                    usage = u;
                const choices = chunk.choices;
                if (!Array.isArray(choices) || choices.length === 0)
                    continue;
                const c = choices[0];
                const fr = c.finish_reason;
                if (typeof fr === 'string' && fr)
                    finish = fr;
                const delta = c.delta;
                if (!delta || typeof delta !== 'object')
                    continue;
                const d = delta;
                if (typeof d.role === 'string' && d.role && !agg.role)
                    agg.role = d.role;
                if (typeof d.content === 'string')
                    agg.content += d.content;
                if (typeof d.reasoning_content === 'string') {
                    agg.reasoning_content = (agg.reasoning_content ?? '') + d.reasoning_content;
                }
                if (Array.isArray(d.tool_calls)) {
                    agg.tool_calls = agg.tool_calls ?? [];
                    for (const tc of d.tool_calls) {
                        if (!tc || typeof tc !== 'object')
                            continue;
                        const t = tc;
                        const idx = typeof t.index === 'number' ? t.index : 0;
                        const fn = (t.function ?? {});
                        const existing = agg.tool_calls.find((x) => x.index === idx);
                        if (existing) {
                            if (typeof fn.name === 'string' && fn.name)
                                existing.function.name = fn.name;
                            if (typeof fn.arguments === 'string')
                                existing.function.arguments += fn.arguments;
                        }
                        else {
                            agg.tool_calls.push({
                                index: idx,
                                id: typeof t.id === 'string' ? t.id : `call_${idx}`,
                                type: typeof t.type === 'string' ? t.type : 'function',
                                function: {
                                    name: typeof fn.name === 'string' ? fn.name : '',
                                    arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
                                },
                            });
                        }
                    }
                }
            }
        }
    }
    finally {
        reader.releaseLock();
    }
    if (!sawChunk)
        throw new Error('上游流不含有效 chunk（聚合失败）');
    /* tool_calls 的 index 在最终响应中不出现（OpenAI 规范）。 */
    const toolCalls = agg.tool_calls?.map((tc) => ({
        id: tc.id ?? '',
        type: tc.type ?? 'function',
        function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
    }));
    const completion = {
        id: id || 'chatcmpl-unknown',
        object: 'chat.completion',
        created: created || Math.floor(Date.now() / 1000),
        model: model || 'unknown',
        choices: [
            {
                index: 0,
                message: {
                    role: agg.role ?? 'assistant',
                    content: agg.content,
                    ...(agg.reasoning_content !== undefined ? { reasoning_content: agg.reasoning_content } : {}),
                    ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: finish,
            },
        ],
        ...(usage ? { usage } : {}),
    };
    return JSON.stringify(completion);
}
