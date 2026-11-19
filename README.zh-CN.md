# dsh-session-rescue

[English](README.md) | [简体中文](README.zh-CN.md)

DeepSeek Harness 0.2.x 的会话可靠性工具套件。它检测两种会让会话卡住的故障：推理重复循环与只有思考没有正文的空轮；记录定位证据，并创建干净会话用于恢复。

## 模块

| 模块 | 作用 | 默认 |
|---|---|---|
| `degen-guard` | 检测推理通道的 token 级重复，中止当前步骤，并按配置执行恢复动作 | 开 |
| `llm-reasoning-retry` | 上游以 `end_turn` 正常结束但只有 thinking、没有正文或工具调用时，用同一请求重发一次 | 开 |
| `llm-wiretap` | 把请求体和上游原始 SSE 写入本地磁盘，供排查使用 | 关，仅在收集证据时开启 |
| `session-inherit` | 机械提取可核对的锚点，新建干净会话并注入交接单；通过 `/inherit` 命令和 `session_inherit` 工具使用 | 开 |
| 前端刷新 | `Ctrl+Shift+R` 只重载渲染进程，不重启宿主 | 开 |

套件只有一个 profile 入口，通过 `guardEnabled`、`retryEnabled`、`inheritEnabled` 和
`wiretapEnabled` 四个开关控制模块。`wiretap` 默认关闭，只在收集诊断证据时开启。
它位于 retry 包装器外层，因此记录的是重试后的响应；retry 模块自己保留空轮证据。

## 安装

```sh
dsh plugin --profile desktop add dsh-session-rescue
```

装完重启 DSH。

### 从独立插件升级

启用本套件前，先禁用并移除 `dsh-degen-guard`、`dsh-llm-wiretap`、`dsh-llm-reasoning-retry`、`dsh-session-inherit` 和 `dsh-render-probe`。两套并存会挂上重复的 fetch 包装与恢复服务，改变重试请求的捕获层级，并可能造成重复的自动继承。

## 熔断后的恢复

`degen-guard` 在同一会话累计多次触发后会熔断。用 `onFused` 选择恢复动作：

| 值 | 行为 |
|---|---|
| `hint`（默认） | 在停止原因里加入 `/inherit <sessionId>`，不创建会话 |
| `draft` | 新建会话并写入交接单，但不启动模型 |
| `auto` | 等源 agent 静止后，带受约束的破局指令启动新会话 |

`auto` 受 `maxAutoChain` 限制（默认 1）。达到上限后再次熔断会降为 `draft`。如果工作区或继承的预设无法校验，同一个子会话会降级为草稿，不会重建。创建超时不会重试。

可以在当前会话中切档：

```text
/degen-mode            查看当前生效值
/degen-mode auto       持久切到 auto
/degen-mode draft      持久切到 draft
/degen-mode hint       持久切到 hint
```

诊断端点会返回 `effectiveOnFused` 和 `effectiveMaxAutoChain`。手改 `cordis.patch.yml` 无需重启即可生效，因为这些字段是 volatile 的。

## 正文不显示

如果助手回复被隐藏，而且只有重启宿主才能恢复，按 `Ctrl+Shift+R`。它只重载渲染进程；正在运行的 agent、会话和任务都在宿主进程里，不受影响。这是快速恢复入口，不会阻止底层 UI 故障本身。

## 本地数据与隐私

- `llm-wiretap` 会把请求体和原始 SSE 写入 DSH home 的日志目录。凭据请求头已经脱敏，但请求体本身可能包含任务内容。排查之外请保持关闭。
- `degen-guard` 会在 DSH home 的 handoff 目录写交接单，并读取会话存档提取锚点。
- `session-inherit` 读取会话日志，并把交接单作为新会话的第一条消息写入。

套件本身不会上传这些文件。

## 验证状态

各模块的本地测试通过，包括服务调用顺序、prompt 前登记深度、超时处理和降级路径。完整的宿主侧恢复链路尚未在真实熔断中观察到。`Ctrl+Shift+R` 刷新快捷键已通过手动验证，能恢复被隐藏的助手回复。

## 反馈

如果某条恢复路径行为异常，或刷新快捷键没能找回正文，请到 https://github.com/MacilyDots/dsh-session-rescue/issues 提 issue，附上 DSH 版本、涉及的模块和 `%DSH_HOME%\logs\` 里的相关日志行。

## 许可

MIT — Macily
