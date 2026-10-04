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

## 实现阶段的最小联调

本轮没有调用 API；下列均为待完成的技术验证：

1. 以一个短请求验证端点、鉴权、模型名，记录模型响应和 request id，日志不记录 token。
2. 验证中文回复、SSE 流式分片、用户取消和连接中断处理。
3. 用无主机副作用的模拟工具验证 function calling：模型请求工具 → 服务端校验参数 → 返回 tool result → 模型继续解释。
4. 覆盖错误 JSON、未知工具、缺字段、额外字段、重复 tool call id，以及多个读工具的并行返回。
5. 实测 thinking 开关、输出限制与工具消息衔接；保留协议要求的消息结构，但不向用户伪称展示内部思考过程。
6. 对 401/403、模型不可用、429、5xx、超时作明确映射；鉴权错误不循环重试，限流只进行有界退避。
7. 建立任务调用次数、token、超时、并发预算；以实测延迟和额度消耗调整默认值。
8. 任何模型失败都不会触发备用付费端点或重复已执行写操作。

只有上述联调完成后，才可将接入状态从“已配置”标为“已验证”。官方文档支持不等于当前账号已经调用成功。

## 语音独立配置

语音链路为麦克风 → ASR → 可编辑文本 → 同一 Agent 流程。当前没有证据证明上述 Coding Plan 文本接口直接提供所需 ASR/TTS，因此不把语音能力当作 DeepSeek 接口的附赠功能。

浏览器 SpeechRecognition 存在兼容性限制，可作为可选增强；正式语音体验需要独立 ASR 适配器，供应方与费用待选择。ASR 不可用时保留文字入口。[MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/SpeechRecognition)

## 凭据处理

不在源码、文档、浏览器变量、Git 历史和普通日志中保存真实 Key。部署时通过服务端秘密配置注入，只有 Provider 客户端读取；日志过滤 Authorization、相关请求头和供应商回显。

用户在会话中提供的凭据未复制到本项目，本轮也没有消耗其额度。后续开发无需再次询问是否使用 Coding Plan；只有缺少有效凭据或真实接口报错时，针对实际问题继续处理。

## 核查来源

- [用户提供的 Coding Plan 控制台](https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan)：页面入口；本轮未登录检查账号权限或余额。
- [Coding Plan 官方套餐概览](https://docs.volcengine.com/docs/ark/coding-plan-personal-plan-overview?lang=zh)：端点、模型别名和配置方式。
- [方舟 Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh)：通用协议与版本化模型字段参考，不能替代 Coding Plan 实测。

核查依赖官方文档的搜索索引内容；部分直接页面读取只返回 JavaScript 提示。未以社区文章推断接口，也未把文档核查写成账号调用测试。
