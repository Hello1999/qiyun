# 运行与接入

本页描述第一版源码开发与主机接入。Linux 控制端安装与升级见 [DEPLOYMENT.md](DEPLOYMENT.md)，产品范围见 [PROJECT.md](PROJECT.md)，实际验收见 [VERIFICATION.md](VERIFICATION.md)。只有明确标记的演示环境使用样例数据。

## 本地开发

需要 Node.js 24.15+ 和 pnpm 11.25.0。首次运行：

```sh
npm install -g pnpm@11.25.0
pnpm install --frozen-lockfile
cp .env.example .env
pnpm run dev
```

Windows 使用 PowerShell 的 `Copy-Item .env.example .env`。如果 `node --version` 为 16，请选择已有 Node.js 24 安装后再运行，不要用旧版本执行项目。

打开 `http://127.0.0.1:5173`。可进入明确标记的演示工作台，或者首次设置自己的管理员密码。演示任务不会连接真实主机或调用模型；退出后删除该演示会话的数据。

控制端监听 `127.0.0.1:4310`，主机通道默认监听 `127.0.0.1:4311`。本地 UI 经 Vite 代理调用 API。应用源码不会读取浏览器中的 API Key。

如果端口被占用，在 `.env` 修改 `QIYUN_PORT`、`QIYUN_AGENT_PORT`，同步更新 `QIYUN_AGENT_URL` 和直接访问控制端时使用的 `QIYUN_ALLOWED_ORIGINS`。`pnpm run dev` 自动将 API 代理指向配置后的控制端端口；Web 开发端口仍为 5173。本文中的 4310 / 4311 均为默认值，不应覆盖用户已有的本地端口选择。

## 模型配置

默认使用指定 Coding Plan 地址与 DeepSeek 模型。直接运行 Node.js / 本地开发时，在服务端 `.env` 配置：

```dotenv
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
ARK_MODEL=deepseek-v4.1-flash
ARK_API_KEY_FILE=/absolute/path/to/private/ark.key
```

秘密文件只含 Key，Linux 权限设为 600，且运行控制端的用户可读；直接运行 Node.js 时也可注入 `ARK_API_KEY` 环境变量。不要使用 `VITE_` 前缀，不要把 Key 放在 URL、Git 或命令行参数里。

通过 Linux 安装器部署时，Key 由隐藏输入或 `QIYUN_ARK_KEY_FILE` 提供，保存在安装状态目录，单文件只读挂载到控制端；容器经 `ARK_API_KEY_FILE` 读取，不将 Key 值放入 Compose 环境变量。可用 `QIYUN_SKIP_ARK=1` 暂不配置，后续补入方式见[模型配置](DEPLOYMENT.md#3-配置模型与端口)。

执行 `node --env-file-if-exists=.env --import tsx scripts/verify-ark.ts` 可完成有界、无主机副作用的真实接口检查。该检查使用标记为 fixture 的样例资源；它会消耗少量模型额度，最多四轮请求，不切换端点。

未配置或模型不可用时仍可浏览资产和记录；服务上的手动重启入口使用固定工具流程，不依赖模型决定执行权限。

## 构建与单命令启动

本机生产构建：

```sh
pnpm run build
node --env-file-if-exists=.env apps/control/dist/server.js
```

构建后控制端同时提供 Web 文件，打开 `http://127.0.0.1:4310`。

已经安装 Docker Engine、Compose v2，并已获取本项目完整源码的 Linux 主机，可以在仓库根目录执行一行命令启动控制端：

```sh
bash deploy/install.sh
```

这会从源码构建并启动控制端，交互式读取 Ark Key、管理员名称和密码，并完成首次管理员初始化；已有管理员和非空 Key 保留。安装器不改动现有业务容器，也不自动安装主机 Agent。无交互安装使用秘密文件，完整变量与维护命令见 [DEPLOYMENT.md](DEPLOYMENT.md)。

控制端 HTTP 端口只发布到本机。远程管理时先用 SSH 本地端口转发；正式公网访问应另行配置 HTTPS 反向代理和精确的 `QIYUN_ALLOWED_ORIGINS`。应用不默认信任任意转发头。

安装配置默认保存在源码目录下 `.local/control-install/deployment.env`，Key 位于相邻 `secrets/ark.key`。维护 Compose 时使用该配置及原项目名，避免意外创建新实例。控制端镜像和构建上下文不包含 `.local`、`.env`、Agent 私钥或用户运行数据。

公开仓库 [Hello1999/qiyun](https://github.com/Hello1999/qiyun) 已建立并推送基础版本。`v0.1.0` 的公共安装入口仍在发行核验中；尚未提供签名发行包、无人值守自动升级或数据库自动回退。跨版本更新需要选择目标 Git 版本后，显式运行 `QIYUN_UPDATE=1 bash deploy/install.sh`。

## 接入 Linux 主机

Agent 使用 Go 标准库，先构建当前平台：

```sh
cd agent
go build -o qiyun-agent ./cmd/qiyun-agent
```

管理员执行以下流程，完整配置示例和 systemd 单元在 `deploy/agent/`，细节见 `agent/README.md`：

1. 在目标 Linux 主机建立专用普通用户；将 Agent 程序放到管理员控制的路径。
2. 配置控制端公开主机名 `QIYUN_AGENT_HOSTNAMES`，首次签发服务器证书前设置。Agent 通道使用独立 HTTPS 端口 4311；设置适当的监听地址和网络访问规则。
3. 从可信控制端取得 `.local/tls/ca.pem`（容器内是 `/data/tls/ca.pem`），经可信文件传输放到 Agent 配置的 `caFile`。核实来源；不要跳过 TLS 校验。
4. 在真实工作台的“接入服务器”生成一次性配对令牌，五分钟有效。将令牌放到只允许该 Agent 用户读取的临时文件，不作为命令行参数。
5. 以 Agent 普通用户运行 `qiyun-agent enroll --config /etc/qiyun/agent.json --token-file /private/path/pairing-token`。完成后删除令牌文件。
6. 默认不启用特权 helper 时，仅采集主机与配置范围内可读取的 systemd 信息。Docker 采集和重启需由管理员另外配置 helper。
7. helper 配置文件、状态目录、签名公钥及所有父目录须为 root 所有，不可被 Agent 修改；不要放在 `/tmp`。将注册得到的签名公钥复制到 root 保护路径。
8. helper 的 Docker/systemd 读取范围、重启白名单、Agent UID/GID 必须明确配置。网络 Agent 使用普通用户；helper 检查 Unix socket 对端 UID，并验证签名、目标、版本和执行记录。
9. 启动 helper 与 Agent 的 systemd 服务，在工作台确认采集时间、服务列表和动作权限。

首次生成证书后，不能通过修改 hostname 环境变量就自动改变已签发证书。当前没有 Web 证书续期/吊销管理页，客户端证书有效期为 90 天；正式长期部署前需补齐证书生命周期管理。不要为修复证书错误直接删除 CA，否则会破坏现有主机信任。

现阶段不自动取服务器上的完整配置或 `.env`；仅上传限定数量的脱敏日志。Docker socket 本身具有高权限，仅 helper 接触它。Web 控制端没有该 socket。

## 操作与恢复语义

- 查询任务不会修改服务器。自然语言产生的重启建议和手动重启使用同一确认流程。
- 审批绑定任务、目标、当前 revision 和到期时间；未确认、状态漂移或离线时不会执行。
- 重启后验证进程/容器状态；这不等于网站业务检查通过，任务卡明确标注该范围。
- 任务开始执行后停止请求不会假装撤销已发生的重启。
- 回执丢失时由 Agent 持久记录恢复；无法确定结果则标记 unknown 并锁住该资源，不自动重放。
- 当前控制端只领取一次写任务。领取响应丢失会进入待核对状态，尚无人工强制解锁界面；不要手动删库来绕过它。
- 配置 Git 历史、Compose 更新/恢复、网站主动探测、定时巡检是后续阶段能力，当前界面不伪装它们已经可用。

## 验证命令

```sh
pnpm run typecheck
pnpm test
pnpm run build
cd agent
go test ./...
go vet ./...
```

Linux 验收脚本 `node scripts/test-linux.mjs` 要求 Docker 和 `.local/artifacts/qiyun-agent-linux-amd64`。它创建随机命名的 `qiyun-fixture-*` 容器，验证真实配对、日志、审批和 Docker 重启；最后仅清理本次创建的容器与镜像。该脚本中的特权 helper 有 Docker socket，但白名单只包含本次测试容器。诊断文件留在 `.local/acceptance-*`。

默认验收不调用模型。显式设置 `QIYUN_TEST_ARK=1` 并运行 `node --env-file-if-exists=.env scripts/test-linux.mjs`，会使用服务端凭据验证自然语言 → 真实方舟工具调用 → 结构化方案 → 批准 → Linux 执行，消耗少量模型额度。每个计划最多四轮请求，不自动重试失败计划。端口默认自动选择，也可用 `QIYUN_TEST_PORT` 指定一对相邻可用端口。

浏览器回归为 `node scripts/test-web.cjs`，需要已启动工作台及现有 Playwright 运行环境。默认使用 Microsoft Edge；其他已安装浏览器可设 `QIYUN_BROWSER_CHANNEL`，地址可设 `QIYUN_WEB_URL`。若 Playwright 不在当前 Node 模块路径中，设置 `QIYUN_PLAYWRIGHT_MODULE` 为它的绝对模块目录。该检查仅创建独立演示会话，完成后退出，截图与报告留在忽略的 `.local`。实际麦克风识别不在自动检查范围内。

源码安装要求支持 `up --wait` 的 Docker Compose v2；脚本在构建后等待健康状态。当前已验证配置解析、Linux 脚本语法、完整控制端镜像构建、容器启动与管理员初始化；目标 VPS 上的完整安装和升级仍需单独验收。详细证据见 [首版验收记录](VERIFICATION.md)。

## 运行数据

直接运行 Node.js 时，SQLite、会话、CA 私钥、签名密钥和任务记录位于 `QIYUN_DATA_DIR`（默认 `.local`）；Compose 部署时保存在项目数据卷的 `/data`，与安装状态目录中的配置 / Key 分开。备份时应使用 SQLite 一致性备份并保护私钥，同时保存安装配置；Git 不能代替该备份。停止或移除容器时保留数据卷，不使用 `--volumes` 删除运行数据。

语音目前使用浏览器可用的 SpeechRecognition，转写后可修改再提交；部分浏览器不支持，识别服务的网络可用性也受浏览器实现影响。独立 ASR 供应商适配尚未实现，不能把按钮存在视作所有浏览器语音均已验证。
