# DSH AtomCode CodingPlan

一个面向 DeepSeek Harness 的实验性 Provider 插件。目标是把 AtomGit CodingPlan 的模型放进 DSH 模型选择器，并由插件自动管理本机桥接进程；用户不需要手动 clone、配置或运行 Atom2Api。

> **状态：0.2.0。已在真实 AtomGit 账户上完成授权与模型发现，但受套餐等级限制，尚无一次成功的模型回复。**
>
> 已实测（macOS arm64 + DeepSeek Harness 0.2.0-rc.2）：
> - 从 GitHub Release 真实下载 Atom2Api `v1.0.9`、校验 SHA-256、解压、仅回环启动；
> - **用真实 AtomGit 账户完成了 OAuth 授权**，账户状态 `active`，模型目录正常返回；
> - 管理 API 认证、API Key 创建与复用、`/v1/models` 与 `/api/models` 读取；
> - **真实 SSE 字节**经 DSH 原生 `StreamChunk` 与真实 `dsh-llm 0.2.0-rc.2` 内核的
>   `BlockAssembler` 还原一致；工具调用增量可还原为可执行调用；`max-tokens` 截断行为正确；
> - `doctor` / `status` / `stop`（含进程退出确认）。
>
> **未通过**：一次成功的模型回复。实测账户为 **CodingPlan Lite-体验版**，其模型目录为
> `glm5.3-flash` / `qwen3.8-27b`，而 Atom2Api 只允许 Lite 套餐调用 DeepSeek 系列模型，
> 因此两个模型都返回 `429 insufficient_quota`（见「已知限制」）。这不是插件缺陷，
> 但意味着 Lite 账户目前无法通过本插件得到任何回复。

## 工作方式

1. DSH 插件加载时，在 `DSH_HOME/atomcode-codingplan/` 下创建本地配置。
2. 插件按需下载固定版本 Atom2Api Release（校验 SHA-256），并作为子进程运行。它只绑定到 `127.0.0.1`，不会监听局域网地址。
3. 第一次请求或执行 `setup` 时启动 AtomGit OAuth 流程。完成浏览器授权后，插件在本地自动创建 API Key 并保存到受限权限的状态文件中。
4. DSH Provider `atomcode-codingplan` 通过 OpenAI Chat Completions 兼容接口请求模型，SSE 结果转换成 DSH 原生 `StreamChunk`。

因此，**不需要单独手工部署 Atom2Api，但这个实现仍会在本机自动运行 Atom2Api 作为桥接子进程**。如果你的要求是完全不使用 Atom2Api 的签名兼容实现、由插件直连 AtomGit 官方上游，这份实现还没有做到——AtomGit 公开仓库只暴露了签名接口，没有公开官方生产客户端的完整签名实现，因此目前不存在既合规又可直接使用的直连方案。

## 安装

macOS 上安装到 Desktop profile：

```bash
npm pack                                    # 在本目录生成 .tgz
./install-macos.sh                          # 默认 profile 为 desktop
# 或直接：
dsh plugin --profile desktop add /绝对路径/dsh-atomcode-codingplan-0.2.0.tgz
```

安装后执行一次授权：

```bash
dsh plugin --profile desktop exec dsh-atomcode-codingplan doctor
dsh plugin --profile desktop exec dsh-atomcode-codingplan setup
```

`doctor` 分阶段输出：插件环境、状态目录、配置、进程、健康检查、账户授权、模型目录、简单请求可达性。输出已脱敏，不含 token、Cookie、API Key、管理密码或加密密钥；有失败阶段时退出码为 1。

`setup` 会启动本地桥接并打开 AtomGit 授权页。完成浏览器授权后插件自动创建供 DSH 使用的 API Key，你无需手工复制任何密钥。

> 若 DSH 版本不接受本地 `.tgz` 路径，可解压源码 ZIP 后用 DSH 插件管理器的本地导入入口；若只提供 npm 包名安装，则需先发布到 npm。安装/升级后请重启对应 DSH 进程。
>
> 若 profile 的 `cordis.patch.yml` 中存在指向本插件且带 `disabled: true` 的条目，插件不会被挂载，Provider 也就不会出现。`doctor` 可用来区分「未安装」与「被停用」。

## 运维命令

```bash
dsh plugin --profile desktop exec dsh-atomcode-codingplan status
dsh plugin --profile desktop exec dsh-atomcode-codingplan doctor
dsh plugin --profile desktop exec dsh-atomcode-codingplan stop
```

本地数据默认位置：`$DSH_HOME/atomcode-codingplan/`（未设置 `DSH_HOME` 时为 `~/.dsh/atomcode-codingplan/`）。这里包含 OAuth/API Key 相关状态、数据库和日志，请勿上传或提交该目录。

## 目前的边界

- 仅支持 macOS，覆盖 Apple Silicon (`arm64`) 与 Intel (`x64`)。Release 资产按平台+架构严格匹配，Intel 机器不会取到 arm64 资产，反之亦然。
- 默认固定 Atom2Api `v1.0.9`；可用 `ATOM2API_VERSION` 调整版本，或用 `ATOM2API_BIN` 指向已审核的本地二进制。**若上游 Release 未提供 SHA-256 校验值，插件会拒绝安装并明确提示，而不是静默跳过校验。**
- 模型列表来自桥接实际返回值。Atom2Api 只在有账户挂载模型后才返回模型，未授权时目录为空；此时插件保留一个引导入口，首次调用会触发授权。
- 上下文窗口取自 Atom2Api 的 `/api/models`（`context_window`）；`/v1/models` 不含该字段，无数据时回落到 64000（与 Atom2Api 自身对缺失值的取值一致）。
- 插件关闭 Atom2Api 自带的 AtomCode 身份 system prompt，system prompt 由 DSH 决定。
- 支持文本与函数工具调用；图像附件会明确报错，不会静默丢弃。
- `stop` 会先确认 PID 确实属于本插件（`ps` 不可用时回退到回环健康检查识别 `service: atom2api`）。无法确认时拒绝发信号且不清除 PID，避免留下孤儿进程或误杀其他进程。
- **受 CodingPlan 套餐等级限制**：Lite 账户当前无法获得任何模型回复，详见下方「已知限制」。

## 0.2.0 相对 0.1.0 修复的问题

0.1.0 在本机无法工作，以下问题均已复现并修复：

| 问题 | 影响 | 修复 |
| --- | --- | --- |
| SSE 只按 `\n\n` 切分事件 | Atom2Api 实际按行输出 `data: {...}\n`、**没有空行分隔**，整条流被缓冲到 EOF，最终**一个 chunk 都不发**，回复全空 | 改为按行解析，同时兼容空行分隔的标准 SSE；已用真实抓包字节做回归测试 |
| `finish.reason` 用 `'length'/'tool-use'/'stop'` | 与内核词表不符，`length` 时不会触发工具调用丢弃逻辑 | 映射为 `max-tokens` / `tool-calls` / `stop` / `error` |
| `context: { maxInputTokens }` | 内核要求 `context.contextWindow` 为正整数，否则整模型被判 `INVALID_MODEL_CONTEXT` | 改为 `contextWindow`，并保证非空 `name` |
| `config.json` 缺 `user_agent`，`encryption_key` 非 32 字节 base64url | Atom2Api 启动即 `log.Fatal`，插件永远起不来 | 生成合规配置；合并而非覆盖用户已有的上游端点配置 |
| 未轮询 `GET /api/oauth/{id}` | 账户只在轮询后才写入，10 分钟授权等待必然超时 | 按会话 id 轮询到 `complete`/`expired` |
| 资产匹配参数传错 | 把 arch 数组当字符串传入，首次真实下载直接抛 `TypeError` | 统一为 `assetMatches(name, osTokens, archTokens)` 并加回归测试 |
| 资产匹配过宽 | Intel 可能取到 arm64 资产 | 平台与架构双向严格匹配 |
| 无 digest 时仍继续安装 | 供应链校验可被静默跳过 | 缺少 SHA-256 时拒绝安装并提示改用 `ATOM2API_BIN` |
| 解压未做越界检查 | 恶意归档可能覆盖任意路径 | 解压后逐项 `realpath` 校验，越界即拒绝 |
| `stop` 吞掉校验失败并清空 PID | 校验失败被误判为「已停止」，留下孤儿进程 | 区分「进程已不存在」与「无法确认身份」，后者拒绝发信号 |
| 归档格式匹配过松 | 可能选中 `SHA256SUMS` 之类非归档资产 | 只接受 `.zip` / `.tar.gz` / `.tgz` |
| 无 `doctor` 分阶段诊断 | 失败时无法定位卡在哪一步 | 新增分阶段脱敏诊断 |

## 开发检查

```bash
npm test          # 25 项单元测试（含真实 Atom2Api SSE 字节回归）
npm run check     # 语法检查 + 单元测试
npm pack
```

可选的真实集成检查（需要可访问 GitHub）：

```bash
node test/live-download.mjs    # 真实 Release 下载 + SHA-256 校验 + 解压 + 启动
ATOM2API_BIN=<atom2api 路径> node test/live-atom2api.mjs   # 真实进程全链路
```

## 已知限制：CodingPlan Lite 目前无法返回回复

Atom2Api 的 `accountEligibleForModel` 对套餐等级做了限制：Lite 等级只允许 DeepSeek 系列
模型，GLM 需要 Pro/Max。而 Lite 账户的模型目录里只有 `glm5.3-flash` / `qwen3.8-27b`，
于是所有模型都返回 `HTTP 429 insufficient_quota / no active account has quota for this model`。

`doctor` 的 `request` 阶段会明确提示这一点，而不是只显示一个 HTTP 状态码：

```
✗ request  模型 glm5.3-flash 返回 insufficient_quota：当前 CodingPlan 套餐等级可能无权使用该模型（Lite 仅支持 DeepSeek 系列），或额度窗口已用尽
```

如果你的账户是 Pro/Max，或后续 AtomGit 为 Lite 开放 DeepSeek 模型，该问题会自动消失。
在此之前，插件能完成授权、能列出模型目录，但无法产出回复。

## 仍需你本机验证

以下步骤需要真实 AtomGit CodingPlan 账户，本仓库无法代为验证：

1. `dsh plugin --profile desktop exec dsh-atomcode-codingplan setup`，在浏览器完成 AtomGit 授权。
2. 确认 `doctor` 中 `account`、`models` 为 `✓` 且能列出真实模型 ID。
3. 确认 `request` 阶段为 `✓`。若为 `✗ insufficient_quota`，先对照上方「已知限制」
   判断是套餐等级问题还是额度窗口用尽。
4. 在 DSH 模型选择器中选择 AtomCode CodingPlan 的模型，发起一次真实对话，确认能正常流式输出。
5. 若要验证工具调用，可让模型调用一个只读工具，确认 DSH 能执行并把结果回传。

> 若你用的是 CodingPlan Pro/Max 账户，请在反馈问题时一并说明套餐等级与模型 ID，
> 这样才能区分「套餐无权使用该模型」和「插件问题」。

排查时请优先运行 `doctor`。若需反馈问题，请提供 `doctor` 输出与 `~/.dsh/atomcode-codingplan/atom2api.log` 末尾若干行，并**先删除其中的 token、Cookie、API Key、管理密码与 `encryption_key`**。

## 参考

- DeepSeek Harness LLM adapter guide: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/practice/llm-adapter.md
- Atom2Api: https://github.com/cnluminous/Atom2Api
- AtomCode login docs: https://atomcode.atomgit.com/docs/zh/login.html
