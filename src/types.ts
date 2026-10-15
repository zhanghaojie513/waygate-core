/**
 * 共享类型（Waygate 家族）。
 *
 * 只放**跨仓库共用**的形状：聊天消息、上游凭证、模型条目、适配器契约。
 * 各家的私有形状（COSY 会话、MiniMax refresh 响应等）留在各自仓库。
 */

/**
 * 入站聊天消息 —— **保持 OpenAI 原始字段名**（snake_case）。
 *
 * 为什么不归一成 camelCase：两家适配器都要读客户端发来的原始形状
 * （`tool_call_id` / `tool_calls` 等），归一反而要求适配器再做一层反查；
 * 且客户端字段可能随版本增减，保留原始形状 + 宽松的可选字段最不容易漏。
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  /** 工具结果消息关联的调用 id（OpenAI 原始字段名）。 */
  tool_call_id?: string;
  /** assistant 消息里的工具调用（OpenAI 原始形状）。 */
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  [key: string]: unknown;
}

/** 入站请求体（两家共用的最小字段集；额外字段由各家适配器自行读取）。 */
export interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  [key: string]: unknown;
}

/** 模型条目：`id` 是路由键（客户端填的模型名），`displayName` 给人看。 */
export interface ModelEntry {
  id: string;
  displayName?: string;
  /** 上游标记（如计价徽标）；无则 null。 */
  tag?: string | null;
}

/** 凭证就绪状态（doctor / 启动输出共用）。 */
export interface CredentialStatus {
  ok: boolean;
  /** 人话描述（如「专用账号 A，access 有效至 2026-11-10」）。 */
  detail: string;
  /** 凭证来源文件路径（给用户排查用；不含令牌本体）。 */
  source?: string;
}

/** 一次上游调用的结果：SSE 字节流（两家最终都归一到 OpenAI SSE 形状）。 */
export interface UpstreamCallResult {
  /** 响应体流（已是 OpenAI 兼容 SSE 形状，或原始裸流由 core 负责写出）。 */
  stream: ReadableStream<Uint8Array>;
  status: number;
}

/** 适配器契约：每家实现这一组钩子，core 负责 HTTP 服务与生命周期。 */
export interface Adapter {
  /** 命令名（如 'qoc' / 'mmcode'），用于错误信息与配置目录。 */
  readonly command: string;
  /** 展示名（如 'Qoder CN' / 'MiniMax Code'）。 */
  readonly displayName: string;
  /** 默认端口。 */
  readonly defaultPort: number;
  /** 人话的上游描述（启动输出用）。 */
  readonly upstreamLabel: string;

  /** 凭证是否就绪 + 人话状态。 */
  credentialStatus(): Promise<CredentialStatus>;
  /** 引导导入/刷新本机客户端登录态（`login` 子命令）。 */
  login(): Promise<void>;
  /** 列出模型（`models` 子命令 + 启动输出）。 */
  listModels(): Promise<ModelEntry[]>;
  /** 处理一次聊天请求，返回 OpenAI 兼容 SSE 流。 */
  chat(body: ChatRequestBody, signal: AbortSignal): Promise<UpstreamCallResult>;
  /** 可选：额外的自检项（如上游连通性）。 */
  doctorChecks?(): Promise<Array<{ name: string; ok: boolean; detail: string }>>;
  /** 可选：本家特有的子命令（如 MiniMax 的签到/积分）。core 负责解析与分发。 */
  /** 登录的一句话说明（帮助文本用）。缺省 = 读本机客户端登录态。 */
  loginHint?: string;
  extraCommands?: ExtraCommand[];
}

/** 适配器自有的子命令（在 core 的通用子命令之外）。 */
export interface ExtraCommand {
  /** 子命令名（如 'checkin' / 'credits'）。 */
  name: string;
  /** 一句话说明（帮助与列表用）。 */
  summary: string;
  /** 用法行（帮助里显示的完整形态）。 */
  usage: string;
  /** 执行；`json` 为真时输出机器可读结果（返回的字符串直接打印）。 */
  run(opts: { json: boolean; args: string[] }): Promise<string>;
}
