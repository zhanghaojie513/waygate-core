# @waygate/core

[waygate-qoder](https://github.com/zhanghaojie513/waygate-qoder) 与
[waygate-mmcode](https://github.com/zhanghaojie513/waygate-mmcode) 共用的骨架。

不面向最终用户 —— 它是**两个反代工具共享的那 80%**：本地 HTTP 服务、入站密钥、配置目录、
启动输出、自检、统一 CLI。上游协议知识（凭证、翻译、模型清单）由各适配器实现 `Adapter` 接口。

## 为什么单独抽包

两个工具的命令面完全一致（`serve` / `models` / `doctor` / `login`），共用一套骨架意味着
**改一处两家都受益**，而不是把同一段代码抄两遍（抄两遍的结局必然是只改一处）。

## 给适配器作者

```ts
import { runCli, type Adapter } from '@waygate/core';

const adapter: Adapter = {
  command: 'qoc',              // 命令名（决定 ~/.waygate/<command>/ 与 sk-<command>- 密钥前缀）
  displayName: 'Qoder CN',
  defaultPort: 8789,
  upstreamLabel: 'https://gateway.qoder.com.cn',
  credentialStatus: async () => ({ ok: true, detail: '…' }),
  login: async () => { /* 导入客户端登录态 */ },
  listModels: async () => [{ id: 'model-key', displayName: 'Model Name' }],
  chat: async (body, signal) => ({ stream /* OpenAI 兼容 SSE */, status: 200 }),
};
await runCli(adapter, { version: '0.1.0' });
```

## License

MIT
