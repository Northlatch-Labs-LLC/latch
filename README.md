<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="Latch" width="128" height="128" />
</div>

<p align="center">
  <a href="https://latch.gridframes.app"><strong>NORTHLATCH · LATCH</strong></a>
</p>
<p align="center">
  一把密钥，逐次计量。每一次模型调用都经由 Northlatch 网关。
</p>
<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

## Latch 是什么

Latch 是 [Northlatch Labs](https://latch.gridframes.app) 的 AI 编程 harness：一个编码 Agent，同时提供三种形态——桌面应用、Web + 服务端，以及终端 Agent（TUI / CLI）。本仓库包含客户端、后端服务、共享 UI，以及 Agent CLI 与运行时源码。

- **计量网关**：每一次模型调用都经由 [Xlaunch Gateway](https://gateway.xlaunch.work) 转发，使用一把统一的 Latch 网关密钥，逐次计量与计价，用量在 [gateway.xlaunch.work/usage](https://gateway.xlaunch.work/usage) 查看。
- **内置模型**：网关内置 `auto` 与 `fusion` 两个模型（见 [config/provider/zcode-builtin.json](config/provider/zcode-builtin.json)）；其他模型商可作为用户自配的自定义供应商接入。
- **登录即密钥**：第一方登录方式是 Latch 网关密钥；无需注册多个模型商账号。

## 安装

### install.sh（终端形态）

`scripts/install.sh` 把产品安装到本机（无需 npm / registry），默认写入 `~/.latch` 并在 `~/.local/bin` 创建 `latch` 命令：

```bash
pnpm --dir apps/zcode-cli run build:sea   # 先构建独立 harness 二进制
scripts/install.sh
latch --help
```

脚本要求先构建 SEA 二进制；`--uninstall` 可卸载，`LATCH_INSTALL_HOME` / `PREFIX` 可改安装位置。详见 [scripts/install.sh](scripts/install.sh)。

### macOS DMG（桌面应用）

```bash
pnpm bundle:desktop
```

产物输出到 `packages/desktop/dist/`（默认 macOS arm64，可用 `--os` / `--arch` 指定目标），双击打开 `Latch-<版本>-mac-<架构>.dmg`，将 Latch 拖入"应用程序"。本地构建未签名，首次打开若被 macOS 拦截，执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Latch.app
```

### 从源码验证

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**（版本以 [mise.toml](mise.toml) 为准），在仓库根目录执行：

```bash
pnpm install
pnpm typecheck
pnpm test:product
```

## 数据目录

Latch 的数据主目录是 `~/.latch`：网关密钥、会话、配置与日志都存放在这里。终端安装器可用 `LATCH_INSTALL_HOME` 覆盖安装位置（数据目录见 [scripts/install.sh](scripts/install.sh)）。

## 网关用量

所有形态的模型调用共享同一把网关密钥与同一份计量账本。用量、费用与额度在 [gateway.xlaunch.work/usage](https://gateway.xlaunch.work/usage) 查看；应用内的"升级"入口也指向该页面。

## Fork 说明（provenance）

Latch 是 [Northlatch Labs](https://latch.gridframes.app) 维护的产品化 fork，基于上游 [zai-org/ZCode](https://github.com/zai-org/ZCode) v3.14.3，依照 **Apache License 2.0** 授权并带有修改（见 [LICENSE](LICENSE)）。上游项目自身的声明完整保留在 [NOTICE.md](NOTICE.md)，本 fork 的派生关系与责任方记录在 [NOTICE](NOTICE)，第三方组件声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
