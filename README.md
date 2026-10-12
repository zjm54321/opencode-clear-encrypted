# opencode-clear-encrypted

OpenCode 本地命令插件，用于在保留完整对话历史的前提下清理失效的加密推理（encrypted reasoning）数据。

## 功能特性

- **本地命令**：在目标会话执行 `/clear-encrypted`（无参数），自动捕获当前会话 ID 与项目目录，不调用模型、不发送 Prompt、不消耗 Token。
- **会话中断与隔离清理**：原生中断当前会话及可能附带的前台子任务并等待完成，随后调用独立的 Bun SQLite helper 进程执行事务清理。注意：当前所拥有的后台子任务（background subagent）不会被自动终止；若会话未静止，命令会拒绝执行，执行前应等待后台任务结束。
- **上下文完整保留**：保留当前 SessionID、消息历史、可见推理文本、工具调用记录及其他会话数据。
- **清理范围**：移除 `assistant`、`event` 与 `providerContext` 中受支持的加密推理元数据及关联 `itemIds`。原生 `compaction` 检查点有意保留，因此若错误源于历史压缩检查点，不保证解决所有 `invalid_encrypted_content`。
- **严格防护与原子事务**：执行前严格校验数据库 Schema、会话状态（无未完成任务或压缩）、目录归属、无分叉（fork）与无副本（replica）。自 0.1.2 起清理不再创建备份目录或文件，事务失败时保持数据库原子回滚。
- **数据擦除说明**：清理为逻辑删除，非安全擦除（SQLite WAL 日志及既有历史备份中可能仍有残留）。自 0.1.2 起新清理不再生成备份，不可通过插件回滚。
- **运行环境**：仅支持 Linux 本地服务端数据库（通过 `/proc/self/fd` 验证服务进程已实际打开目标库）。支持远程客户端连接，由服务端解析并执行数据库操作。经 OpenCode 2.0.26 + Bun 1.4.2 验证；基于实际接口与 Schema 校验，不锁定固定版本号。

## 安装与配置

本包仅分发 TypeScript 源码与运行时逻辑，不包含预编译二进制，无 postinstall 脚本或下载器。

### 方式一：npm 安装（推荐）

在 `opencode.json`（或 `opencode.jsonc`）中声明插件（OpenCode V2 规范）：

```json
{
  "plugins": [
    "opencode-clear-encrypted@0.1.2"
  ]
}
```

OpenCode 会自动下载并加载 npm 插件及其 `./tui` 导出（无需修改 `cli.json`）。

> **注意：仅配置插件项无法独立完成运行，服务端仍必须提供 Bun 运行时。**
> 插件不会自动从 PATH 探测二进制，也不会在后台下载任何运行时。必须在**服务端进程宿主环境**显式声明受信的 Bun 绝对路径：
> ```sh
> export OPENCODE_CLEAR_ENCRYPTED_BUN="/path/to/trusted/bun"
> ```
> - **运行时解析规则**：显式变量 `OPENCODE_CLEAR_ENCRYPTED_BUN`（设置无效或空直接拒绝，不回退） > 源码目录同级 `bun` 符号链接 > 拒绝执行。路径校验与 `:memory:` 探测仅用于验证基本功能与兼容性；配置该变量即代表明确授权使用该运行时以**服务进程所属用户的权限**执行代码。
> - **Nix 用户说明**：在 NixOS / Home Manager 等受管环境中，启动包装脚本（launcher / wrapper）通常会自动导出不可变 Store 路径下的 Bun，无需手动 export；非 Nix 用户请在 systemd 单元或启动环境中配置。配置后需重启 OpenCode 服务以生效。

### 方式二：Nix / Home Manager 独立包（可选替代）

若通过 Nix 管理配置，可直接使用独立 Flake 包作为替代路径，**无需与 npm 方式重复添加**：

```nix
# 在 flake.nix inputs 添加: github:zjm54321/opencode-clear-encrypted
xdg.configFile."opencode/plugins/clear-encrypted" = {
  source = inputs.opencode-clear-encrypted.packages.${pkgs.stdenv.hostPlatform.system}.default;
  recursive = false;
};
```

该包已自带指向 Nix Store 中 Bun 的符号链接。使用受管模块的 Nix 用户请按实际环境调整，本仓库不包含自动部署。

## 历史备份手动恢复

> **注意**：自 0.1.2 起清理不再创建备份，新清理无法通过插件恢复。既有历史备份不受影响；以下恢复操作仅适用于此前版本生成的有效历史备份文件（v1）。

- **历史备份存储与权限**：既有历史备份位于服务端的 `$XDG_STATE_HOME/opencode/clear-encrypted/<dbidentity>/`（默认 `~/.local/state/opencode/clear-encrypted/<dbidentity>/`），备份文件权限为 `0600`，目录为 `0700`（含敏感对话数据）。
- **手动恢复机制**：仅当存在有效的既有历史备份时，可通过向 helper 进程输入 JSON 契约实现恢复（无独立 CLI 命令包装）。恢复前请先停止目标会话，切勿猜测数据库路径或手动覆盖数据库文件：

```sh
# npm 安装使用 <pkg-root>/src/helper.ts；Nix 安装使用 <plugin-root>/helper.ts
printf '%s\n' '{"operation":"restore","dbPath":"/absolute/path/to/opencode.db","sessionID":"ses_...","directory":"/absolute/path/to/project","backupPath":"/absolute/path/to/backup.json"}' |
  "$OPENCODE_CLEAR_ENCRYPTED_BUN" /path/to/helper.ts
```

> helper 会严格校验会话归属、数据库身份与冲突状态，遇到不一致时保守拒绝。

## 本地开发与发布

```sh
nix develop          # 进入 Nix 开发环境
bun test             # 运行单元测试
npm pack --dry-run   # 校验 npm 打包产物
```

发布与 CI/CD 流程说明详见：[PUBLISHING.md](https://github.com/zjm54321/opencode-clear-encrypted/blob/main/PUBLISHING.md)（由于 npm 发布白名单排除了开发文档，请访问 GitHub 查看）。

## 许可证

本项目采用 [GNU General Public License v3.0 or later (GPL-3.0-or-later)](LICENSE) 开源。
