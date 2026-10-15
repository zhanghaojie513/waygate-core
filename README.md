# waygate-core

<div align="center">

**途关家族 · 共享骨架**

三个本地反代工具共用的那 80%

[![npm](https://img.shields.io/npm/v/waygate-core?style=flat-square&color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/waygate-core)
![Node](https://img.shields.io/badge/Node-%E2%89%A520-3C873A?style=flat-square&logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

[waygate-qoder](https://github.com/zhanghaojie513/waygate-qoder) · [waygate-mmcode](https://github.com/zhanghaojie513/waygate-mmcode) · [waygate-workbuddy](https://github.com/zhanghaojie513/waygate-workbuddy) · [适配器接口](#给适配器作者)

</div>

---

**不面向最终用户** —— 这个包是三个反代工具共享的骨架，上游协议知识（凭证、翻译、模型清单）由各适配器实现 `Adapter` 接口。

它管的是每个本地反代**都一样**的部分：

- **本地 HTTP 服务** —— OpenAI / Anthropic 双端点、SSE 流原样透传、客户端断连即中止上游
- **流式与非流式** —— `stream: false` 时自动把 SSE 聚合成单个 `chat.completion` JSON（符合 OpenAI 规范）
- **入站密钥** —— 自动生成（`sk-<command>-…`）、落盘复用（客户端只需配一次）
- **配置目录** —— `~/.waygate/<command>/`，跨命令互不干扰
- **统一 CLI** —— `serve` / `models` / `doctor` / `login` 四个子命令，三家完全同构
- **扩展子命令** —— 适配器可注册自家专属命令（如 `mmcode checkin`），CLI 统一解析与分发
- **启动输出** —— 「凭证状态 + 代理地址 + 密钥 + 模型 ID」一屏内复制得走；`--json` 机器可读
- **自检** —— 端口占用 / 凭证 / 模型清单 / 上游连通，逐项给人话结论 + 下一步动作

## 为什么单独抽包

三个工具的命令面完全一致（`serve` / `models` / `doctor` / `login`），共用一套骨架意味着**改一处三家都受益**，而不是把同一段代码抄三遍（抄三遍的结局必然是只改一处）。

```mermaid
flowchart LR
  subgraph adapters [适配器仓库]
    Q[waygate-qoder<br/>COSY 签名 · DPAPI 解密]
    M[waygate-mmcode<br/>Anthropic 兼容 · 明文 JSON]
    W[waygate-workbuddy<br/>官方 OAuth 设备授权]
  end
  C[waygate-core 包<br/>HTTP 服务 · 密钥 · CLI · 自检]
  Q -->|Adapter 接口| C
  M -->|Adapter 接口| C
  W -->|Adapter 接口| C

  style C fill:#EDE9FE,stroke:#8B5CF6,color:#1F2328
  style Q fill:#FFFFFF,stroke:#D0D7DE,color:#1F2328
  style M fill:#FFFFFF,stroke:#D0D7DE,color:#1F2328
  style W fill:#FFFFFF,stroke:#D0D7DE,color:#1F2328
  style adapters fill:#F6F8FA,stroke:#D0D7DE
```

## 给适配器作者

```ts
import { runCli, type Adapter } from 'waygate-core';

const adapter: Adapter = {
  command: 'qoc',              // 命令名（决定 ~/.waygate/<command>/ 与 sk-<command>- 密钥前缀）
  displayName: 'Qoder CN',
  defaultPort: 8789,
  upstreamLabel: 'https://gateway.qoder.com.cn',
  credentialStatus: async () => ({ ok: true, detail: '…' }),
  login: async () => { /* 导入客户端登录态 */ },
  listModels: async () => [{ id: 'model-key', displayName: 'Model Name' }],
  chat: async (body, signal) => ({ stream /* OpenAI 兼容 SSE */, status: 200 }),
  doctorChecks: async () => [],  // 可选：额外的自检项

  /* 可选：本家专属子命令（core 负责解析、help 展示、分发） */
  extraCommands: [{
    name: 'checkin', summary: '每日签到领积分', usage: 'checkin',
    run: async ({ json }) => (json ? '{}' : '✓ 签到成功'),
  }],
};
await runCli(adapter, { version: '0.1.0' });
```

实现核心钩子，core 会替你处理 HTTP 服务、密钥管理、CLI 解析、启动输出、自检——你只写上游协议那一层。

> 安装：`npm i waygate-core`（仓库同时保留 `dist/`，供 GitHub 直装兜底）。

## 相关项目

- **[waygate-qoder](https://github.com/zhanghaojie513/waygate-qoder)** —— Qoder CN 本地反代（命令 `qoc`，`npm i -g waygate-qoder`）
- **[waygate-mmcode](https://github.com/zhanghaojie513/waygate-mmcode)** —— MiniMax Code 本地反代（命令 `mmcode`，`npm i -g waygate-mmcode`）
- **[waygate-workbuddy](https://github.com/zhanghaojie513/waygate-workbuddy)** —— WorkBuddy 本地反代（命令 `wb`，`npm i -g waygate-workbuddy`）
- **[waygate-open](https://github.com/zhanghaojie513/waygate-open)** —— 同一作者的完整多提供商反代（含控制台、用量统计）

## License

MIT
