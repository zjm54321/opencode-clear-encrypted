# 发布流程与 Trusted Publishing 指南

本项目（`opencode-clear-encrypted@0.1.0`，代码仓库 `zjm54321/opencode-clear-encrypted`）采用从**首次手动登录引导**过渡到 **GitHub Actions OIDC (Trusted Publishing)** 的免持久 Token 自动化发布方案。

> **安全规范**：严禁在聊天、配置或仓库中粘贴或持久化存储 npm Token。

---

## 1. 首次发布引导（Bootstrap）

由于 npm 平台要求**软件包必须已存在于 npm Registry** 方可配置 Trusted Publisher，因此首次发布（v0.1.0）须由维护者进行一次性手动授权：

1. **维护者登录**：维护者在本地终端执行网页授权登录（根据 npm 提示完成必要的 2FA）：
   ```sh
   npm login --auth-type=web
   ```
2. **助手 / 维护者发布**：授权完成后，执行首次发布：
   ```sh
   npm publish --access public
   ```
   *注意：当前包尚未发布，首次发布请勿在发布后推送 `v0.1.0` Git tag（避免 CI 触发重复发布导致冲突）。*

---

## 2. 配置 npm Trusted Publisher

首次手动发布成功后，即可在 npmjs.com 上为代码仓库配置 Trusted Publisher：

1. 进入 npm 网页端软件包管理设置（Settings -> Trusted Publishers）。
2. 添加 **GitHub Actions** 关联：
   - **GitHub Organization / Owner**: `zjm54321`
   - **Repository**: `opencode-clear-encrypted`
   - **Workflow filename**: `publish.yml`
   - **Environment**: `npm`
   - **发布模式**：勾选允许 **Direct publish**（注意：2026 年 9 月 3 日之后的配置默认启用 staged 暂存发布，需确保允许直接发布）。
3. 官方参考文档：
   - [npm Trusted Publishers 文档](https://docs.npmjs.com/trusted-publishers)
   - [npm trust CLI 文档](https://docs.npmjs.com/cli/v12/commands/npm-trust)
   *注：官方 `npm trust` CLI 语法仍在核验中，在此之前推荐通过 Web 界面完成配置，待核验确认后再补充 CLI 替代方案。*

---

## 3. 后续版本发布流程（CI / OIDC）

配置 Trusted Publisher 后，后续版本（`v0.1.1` 及以上）完全通过 GitHub Actions 自动化发布，无需配置 `NODE_AUTH_TOKEN`：

1. **版本更新与提交**：在 `package.json` 中递增版本号并提交至 `main` 分支。
2. **推送版本 Tag**：
   ```sh
   git tag v<version>
   git push origin v<version>
   ```
3. **自动流水线验证与发布**：
   - 工作流仅在发布任务中声明 `contents: read` 与 `id-token: write` 最小权限。
   - 自动校验 Tag 与 `package.json` 的包名和版本匹配。
   - 环境已在 Node 24（npm >= 11.5.1）与 Bun 1.4.2 下验证，自动执行 `bun test` 与 `npm pack --dry-run` 校验，并通过 OIDC 生成 Provenance。

*注：首次 OIDC 自动化端到端发布尚未在真实仓库执行验证，请在后续首个自动化版本发布时关注 Action 运行状态。*
