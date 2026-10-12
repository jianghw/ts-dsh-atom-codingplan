#!/usr/bin/env node
import { AtomCodeBridge } from './bridge.js';

const command = process.argv[2] || 'help';
const bridge = new AtomCodeBridge();

/** Strip anything that could carry a credential before printing. */
function redact(text) {
  return String(text)
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1<redacted>')
    .replace(/(sk-atom2-)[A-Za-z0-9._-]{8,}/gi, '$1<redacted>')
    .replace(/((?:password|token|secret|cookie|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, '$1<redacted>');
}

async function main() {
  if (command === 'setup' || command === 'login' || command === 'connect') {
    console.log('正在启动由插件管理的 Atom2Api 本地桥接……');
    const result = await bridge.setup();
    console.log(result.alreadyConnected ? 'AtomGit 账户已连接。' : 'AtomGit 账户授权完成。');
    console.log(`已连接账户数：${result.accounts}`);
    console.log(`可用模型（${result.models.length}）：${result.models.join(', ') || '(未返回模型)'}`);
    console.log('现在可以在 DeepSeek Harness 模型列表中选择 AtomCode CodingPlan。');
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(await bridge.status(), null, 2));
    return;
  }
  if (command === 'doctor') {
    const report = await bridge.doctor();
    console.log('AtomCode CodingPlan 诊断报告');
    for (const stage of report.stages) {
      const mark = stage.status === 'ok' ? '✓' : '✗';
      console.log(`  ${mark} ${stage.stage.padEnd(12)} ${redact(stage.detail)}`);
    }
    console.log('');
    console.log('提示：桥接只监听 127.0.0.1；Atom2Api 签名层是社区兼容实现，不是 AtomGit 官方 SDK。');
    const failed = report.stages.filter((stage) => stage.status === 'fail');
    process.exitCode = failed.length ? 1 : 0;
    return;
  }
  if (command === 'stop') {
    console.log(JSON.stringify(await bridge.stop(), null, 2));
    return;
  }
  console.log(`DSH AtomCode CodingPlan 插件

用法：
  dsh plugin --profile desktop exec dsh-atomcode-codingplan setup
  dsh plugin --profile desktop exec dsh-atomcode-codingplan status
  dsh plugin --profile desktop exec dsh-atomcode-codingplan doctor
  dsh plugin --profile desktop exec dsh-atomcode-codingplan stop

setup 首次会打开 AtomGit 授权页；完成授权后插件会自动创建内部 API Key，
用户无需手工部署 Atom2Api 或复制 API Key。`);
}

main().catch((error) => {
  console.error(`[dsh-atomcode-codingplan] ${redact(error.stack || error.message)}`);
  process.exitCode = 1;
});
