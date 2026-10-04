# 方舟接入核查与决定

核查日期：2026-10-04。用户指定使用火山方舟 Ark（不是 Arc），默认模型为 DeepSeek V4.1 Flash。

## 接入决定

用户已明确：以 Coding Plan 作为本产品的 Agent API 接入方式；不把套餐适用范围作为工程推进前置条件。

| 配置项 | 决定 |
| --- | --- |
| Provider | Ark Coding Plan |
| 默认协议 | OpenAI-compatible Chat Completions |
| Base URL | `https://ark.cn-beijing.volces.com/api/coding/v3` |
| 模型名称 | `deepseek-v4.1-flash` |
| 凭据来源 | 服务端运行时秘密配置 |
| 备用端点 | 不自动启用，不回退到通用按量付费端点 |
| 模型切换 | 用户显式配置；记录实际 model id 和能力探测结果 |

该端点、模型别名及 `ark-code-latest` 控制台选型方式见 [Coding Plan 套餐概览](https://docs.volcengine.com/docs/ark/coding-plan-personal-plan-overview?lang=zh)。用户截图与官方文档中的 Coding Plan Base URL 一致。本项目固定具体模型，避免控制台模型切换导致行为悄然改变。

## 区分不同模型标识

Coding Plan 使用 `deepseek-v4.1-flash`；方舟通用 API 文档中还出现 `deepseek-v4-1-flash-260910` 这一版本标识。不同端点的标识与能力不能直接互换，当前项目不使用后者作为 Coding Plan 的默认名称。[方舟 Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh)

`ark-code-latest` 是可由控制台改变路由的别名，适合作为可选配置，不用于要求可复现的默认运维流程。不能仅根据“OpenAI 兼容”推断所有参数、Responses 功能或模型行为都一致。

## 当前联调结果

2026-10-04 先完成一次真实简单连通性探测，再通过 `scripts/verify-ark.ts` 完成一次流式工具调用冒烟。后一次工具循环包含 2 次模型请求，接口报告合计输入 1,309 / 输出 90 tokens。

测试使用指定 Coding Plan 端点和模型，模型调用只读资产工具，服务端返回明确标记为 fixture 的样例资源，模型继续完成中文回复；没有连接或修改真实主机，也没有切换备用端点。

这验证了当次凭据、端点、流式工具消息衔接与简单中文输出，不代表所有错误路径、限流额度、长上下文或真实故障诊断均已验证。请求会消耗模型额度；token 用量不等同于实际套餐账单。

控制端已实现流式响应解析、有限工具调用循环、参数与目标校验、超时 / 取消、供应商错误映射及请求用量记录。配套单元测试使用固定响应覆盖异常路径；没有人为向真实供应商制造全部 401 / 429 / 5xx 情况。

界面的“已验证”表示当前控制端进程观察到实际调用成功。独立冒烟脚本运行成功，不会自动把另一进程中的状态改为已验证。

随后通过 `QIYUN_TEST_ARK=1` 完成真实模型与 Linux Agent 的端到端验收：自然语言请求 → 读取服务 → 结构化重启提议 → 人工批准 → 签名任务 → 隔离容器实际重启及状态验证。该成功任务包含 3 次模型请求，输入 2,810 / 输出 349 tokens。初次尝试发现模型只给出文本计划的问题，调整提示后复测通过；具体范围见 [VERIFICATION.md](VERIFICATION.md)。这些 token 数不包含其他探测与失败尝试，不是账单合计。

## 后续联调清单

下面保留完整验收要求；简单冒烟以外的供应商行为与可靠性仍需逐项记录，不能整体写作已完成：

1. 以一个短请求验证端点、鉴权、模型名，记录模型响应和 request id，日志不记录 token。
2. 验证中文回复、SSE 流式分片、用户取消和连接中断处理。
3. 用无主机副作用的模拟工具验证 function calling：模型请求工具 → 服务端校验参数 → 返回 tool result → 模型继续解释。
4. 覆盖错误 JSON、未知工具、缺字段、额外字段、重复 tool call id，以及多个读工具的并行返回。
5. 实测 thinking 开关、输出限制与工具消息衔接；保留协议要求的消息结构，但不向用户伪称展示内部思考过程。
6. 对 401/403、模型不可用、429、5xx、超时作明确映射；鉴权错误不循环重试，限流只进行有界退避。
7. 建立任务调用次数、token、超时、并发预算；以实测延迟和额度消耗调整默认值。
8. 任何模型失败都不会触发备用付费端点或重复已执行写操作。

“已配置”仅表示服务端存在凭据；“已验证”仍不代表完整清单全部通过。真实测试结论与固定响应测试、官方文档支持分别记录。

## 语音独立配置

语音链路为麦克风 → ASR → 可编辑文本 → 同一 Agent 流程。当前没有证据证明上述 Coding Plan 文本接口直接提供所需 ASR/TTS，因此不把语音能力当作 DeepSeek 接口的附赠功能。

Web 首版已实现浏览器 SpeechRecognition 特性检测、点击录音、可编辑转写及失败时的文字入口。浏览器支持和识别服务联网能力仍有限制；尚未实现独立 ASR 适配器，供应方与费用待选择，不宣称所有浏览器的实际语音识别已通过。[MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/SpeechRecognition)

## 凭据处理

不在源码、文档、浏览器变量、Git 历史和普通日志中保存真实 Key。部署时通过服务端秘密配置注入，只有 Provider 客户端读取；日志过滤 Authorization、相关请求头和供应商回显。

实际联调从服务端环境变量或秘密文件读取凭据，未把凭据写入源码、本文或示例。真实冒烟已经产生调用用量，具体套餐额度 / 金额没有可靠账单数据时不作推算。后续开发按既定 Coding Plan 接入；遇到缺少有效凭据或真实接口错误时，针对实际问题处理。

## 核查来源

- [用户提供的 Coding Plan 控制台](https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan)：页面入口；本轮未登录检查账号权限或余额。
- [Coding Plan 官方套餐概览](https://docs.volcengine.com/docs/ark/coding-plan-personal-plan-overview?lang=zh)：端点、模型别名和配置方式。
- [方舟 Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh)：通用协议与版本化模型字段参考，不能替代 Coding Plan 实测。

最初的文档核查依赖官方搜索索引；部分直接页面读取只返回 JavaScript 提示。上方实际联调结果来自后续代码运行，和这些文档来源分开记录。
