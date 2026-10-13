/**
 * 自检（`doctor` 子命令）：把「为什么用不了」拆成可逐项排查的检查清单。
 *
 * 顺序按「用户能自己解决」靠前：端口占用 → 凭证 → 模型 → 上游连通。
 * 每项都给人话结论 + 下一步动作（不抛栈）。
 */
import { createServer } from 'node:net';
/** 端口是否可用（能监听即视为可用）。 */
export async function checkPortFree(host, port) {
    const bindHost = host === '0.0.0.0' || host === '::' ? '0.0.0.0' : host;
    return new Promise((resolve) => {
        const probe = createServer();
        probe.once('error', (err) => {
            resolve({
                name: `端口 ${port}`,
                ok: false,
                detail: err.code === 'EADDRINUSE'
                    ? `已被占用 —— 换一个端口（--port ${port + 1}），或先停掉占用该端口的程序`
                    : `无法监听：${err.message}`,
            });
        });
        probe.listen(port, bindHost, () => {
            probe.close(() => resolve({ name: `端口 ${port}`, ok: true, detail: '可用' }));
        });
    });
}
/** 跑完整自检（适配器提供凭证/模型/上游项）。 */
export async function runDoctor(adapter, host, port) {
    const results = [];
    results.push(await checkPortFree(host, port));
    const cred = await adapter.credentialStatus();
    results.push({ name: '凭证', ok: cred.ok, detail: cred.detail + (cred.source ? `（${cred.source}）` : '') });
    if (cred.ok) {
        try {
            const models = await adapter.listModels();
            results.push({
                name: '模型清单',
                ok: models.length > 0,
                detail: models.length > 0 ? `${models.length} 个：${models.slice(0, 3).map((m) => m.id).join('、')}${models.length > 3 ? ' …' : ''}` : '拉不到模型 —— 上游可能改了接口，或凭证已失效',
            });
        }
        catch (err) {
            results.push({ name: '模型清单', ok: false, detail: err.message });
        }
    }
    if (adapter.doctorChecks) {
        results.push(...(await adapter.doctorChecks()));
    }
    return results;
}
export function renderDoctor(results) {
    const lines = results.map((r) => `${r.ok ? '✓' : '✗'} ${r.name}    ${r.detail}`);
    const allOk = results.every((r) => r.ok);
    lines.push('');
    lines.push(allOk ? '全部通过 —— 直接运行对应命令即可启动反代。' : '有项目未通过 —— 按上面的提示处理后重跑 doctor。');
    return lines.join('\n');
}
