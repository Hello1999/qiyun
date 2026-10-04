# Linux 部署

一行安装会部署栖云控制端，包含 Web 工作台、API 和持久化数据。Linux Agent 单独接入；安装控制端不会自动读取或操作服务器上的业务容器。

## 1. 安装

准备一台可访问 GitHub 和 Docker 软件源的 Linux 服务器，以及 Bash、`curl` 和 `sudo` 权限。脚本默认将源码放在 `/opt/qiyun`，检查 Git、Docker Engine 和 Compose v2。支持的 Ubuntu / Debian 可补装 Git；Docker 完全未安装且没有冲突容器运行时包时，可通过官方 APT 软件源安装。已有 Docker 但缺少 Compose 时，按终端提示补齐插件，不替换现有 Engine。

固定版本 `v0.1.0`。公开源码下载、终端初始化与重复安装已通过 Ubuntu 24.04 / amd64 的 [GitHub 验收](https://github.com/Hello1999/qiyun/actions/runs/37187976534)。已是 root 用户时可去掉 `sudo`。

```sh
curl -fsSL https://raw.githubusercontent.com/Hello1999/qiyun/v0.1.0/install.sh | sudo env QIYUN_REF=v0.1.0 bash
```

按提示完成三项输入：

1. **Ark API Key**：隐藏输入并保存为私有文件；也可以选择跳过，稍后配置模型。
2. **管理员名称**：用于工作台显示。
3. **管理员密码**：至少 12 位字符，隐藏输入；已有管理员不会被重置。

安装器构建并启动控制端，等待健康检查通过后打印访问地址。源码默认在 `/opt/qiyun`，安装配置与模型秘密文件默认在 `/opt/qiyun/.local/control-install`，运行数据保留在项目的 Docker 数据卷中。同版本重跑保留既有配置、密钥和数据。

如果已克隆完整源码并准备好 Docker / Compose，在仓库根目录执行 `bash deploy/install.sh` 即可使用同一控制端安装流程。

## 2. 打开工作台

默认 Web 只监听服务器本机 `127.0.0.1:4310`。在自己的电脑运行：

```sh
ssh -N -L 4310:127.0.0.1:4310 你的用户@服务器IP
```

保持该终端连接，在本地浏览器打开 `http://127.0.0.1:4310`，使用刚创建的管理员登录。只想先看看界面时，可以选择明确标记的演示环境。

如果已有 HTTPS 反向代理，将它转发到服务器的 `127.0.0.1:4310`，并在部署配置中将 `QIYUN_ALLOWED_ORIGINS` 设为实际 HTTPS Origin，例如 `https://ops.example.com`，不要附带路径或使用通配符。这里的域名只是填写示例，需替换为自己的域名。反向代理需位于能够访问该回环地址的位置。

## 3. 配置模型与端口

默认模型为 `deepseek-v4.1-flash`，使用 Ark Coding Plan 地址 `https://ark.cn-beijing.volces.com/api/coding/v3`。凭据由服务端读取，不发送到浏览器。

安装器保存以下文件：

| 位置 | 用途 |
| --- | --- |
| `STATE_DIR/deployment.env` | 端口、允许来源、模型路径等部署配置 |
| `STATE_DIR/secrets/ark.key` | Ark Key，单文件只读挂载到控制端 |
| Docker 项目数据卷 | SQLite、会话、任务、CA 和签名私钥 |

其中 `STATE_DIR` 默认是 `/opt/qiyun/.local/control-install`。新安装可通过环境变量选择配置；已有安装优先读取保存的配置，不会因再次输入同名环境变量而悄悄改变运行环境。

| 变量 | 默认 / 用途 |
| --- | --- |
| `QIYUN_INSTALL_DIR` | 源码目录，默认 `/opt/qiyun` |
| `QIYUN_REF` | 目标版本标签或完整 40 位提交 SHA，默认 `v0.1.0` |
| `QIYUN_INSTALL_DEPS` | 默认 `1`；设为 `0` 时缺少依赖则退出并提示 |
| `QIYUN_STATE_DIR` | 安装状态目录，默认源码目录下 `.local/control-install` |
| `QIYUN_PROJECT_NAME` | Docker Compose 项目名，默认 `qiyun` |
| `QIYUN_PORT` | Web 本机端口，默认 `4310` |
| `QIYUN_AGENT_PORT` | Agent HTTPS 端口，默认 `4311` |
| `QIYUN_AGENT_BIND` | 默认 `127.0.0.1`；远程主机接入时单独配置 |
| `QIYUN_ALLOWED_ORIGINS` | 精确的浏览器来源；默认允许本机 Web 地址 |
| `QIYUN_AGENT_URL` / `QIYUN_AGENT_HOSTNAMES` | 主机访问地址与证书主机名，首次签发证书前确定 |

后续更改端口或 HTTPS 来源时，编辑保存的 `deployment.env` 并使用下节的 Compose 命令重新创建控制端。既有证书不会随主机名配置变化自动重签。

首次跳过模型配置会创建空的 `secrets/ark.key`，工作台显示“尚未配置”。稍后可重跑安装器并按提示输入 Key，或明确提供秘密文件：

```sh
sudo env QIYUN_ARK_KEY_FILE=/安全目录/ark-key bash /opt/qiyun/deploy/install.sh
```

把路径替换为实际文件。安装器只补入空 Key，不覆盖已有非空 Key。需要更换已有 Key 时，由管理员编辑状态目录中的 `secrets/ark.key`，保持文件 UID/GID 为 `1000:1000`、权限为 `0400`，然后使用下节命令重新创建控制端。

## 4. 查看与维护服务

使用默认目录和项目名时：

```sh
sudo docker compose --project-directory /opt/qiyun/deploy --project-name qiyun --env-file /opt/qiyun/.local/control-install/deployment.env -f /opt/qiyun/deploy/compose.yaml ps
```

同一命令末尾的 `ps` 可以替换为：

- `logs --tail 100 control`：查看最近控制端日志。
- `up -d --wait`：应用保存的配置并启动服务。
- `up -d --force-recreate --wait control`：更换 Key 文件后重新创建控制端，刷新只读文件挂载；仅 `restart` 可能仍使用旧文件。
- `stop`：停止服务，保留容器与数据。

自定义过源码目录、状态目录或项目名时，使用对应值。备份须同时考虑 Docker 数据卷中的 SQLite 一致性、私钥及状态目录中的配置与秘密文件；源码 Git 记录不包含这些运行数据。

## 5. 升级

升级需主动选择已发布版本。先备份运行数据，确认工作台没有正在执行的写任务；在源码目录检查并处理本地代码修改，然后获取目标版本：

```sh
cd /opt/qiyun
sudo git status --short
sudo git fetch origin --tags
read -r -p '目标发布标签或完整提交 SHA：' QIYUN_TARGET_REF
sudo git checkout --detach "$QIYUN_TARGET_REF"
sudo env QIYUN_UPDATE=1 bash deploy/install.sh
```

`QIYUN_UPDATE=1` 明确允许从当前已检出的代码重建控制端，保留现有配置、Ark Key、管理员和数据卷。根安装器遇到已安装目录与请求版本不一致时会退出，不会自动切换或覆盖源码。

安装器不承诺自动回退数据库，也不将切回旧 Git 版本视为数据恢复。升级后的访问地址与状态目录保持不变。

## 6. 无交互安装

自动化部署使用只允许部署用户读取的秘密文件，每个文件一行，不把密码或 Key 写进命令参数。已经准备好源码和秘密文件时：

```sh
sudo env \
  QIYUN_NONINTERACTIVE=1 \
  QIYUN_ADMIN_NAME='管理员' \
  QIYUN_ADMIN_PASSWORD_FILE=/安全目录/admin-password \
  QIYUN_ARK_KEY_FILE=/安全目录/ark-key \
  bash /opt/qiyun/deploy/install.sh
```

将示例中的文件路径替换为实际绝对路径。首次安装暂不配置模型时，用 `QIYUN_SKIP_ARK=1` 替代 `QIYUN_ARK_KEY_FILE`。管理员密码只经标准输入传给初始化工具，不保存为安装配置。已有部署重跑不重置管理员或模型密钥。

## 7. 接入 Linux 主机

登录真实工作台，在“服务器”生成一次性配对令牌，然后按 [Agent 配置说明](../agent/README.md)部署普通用户 Agent、可信 CA 和必要的 helper 白名单。

默认 Agent 通道也只绑定服务器本机。跨主机接入需先配置实际 HTTPS 地址、证书主机名、监听地址与网络访问规则。Docker 读取与重启分别授权；只读发现容器不会自动授予重启权限。

详细注册与权限步骤见[运行与接入](RUNNING.md#接入-linux-主机)。当前还没有自动 Agent 安装、证书轮换、网站主动 HTTP / TLS 检测、配置回滚或定时自动修复。
