# 发布流程与 Trusted Publishing 指南

本项目（`opencode-clear-encrypted`，代码仓库 `zjm54321/opencode-clear-encrypted`）采用基于 **GitHub Actions OIDC (Trusted Publishing)** 的免持久 Token 自动化发布方案。

> **安全规范**：严禁在聊天、配置或仓库中粘贴或持久化存储 npm Token。

---

## 1. 首次发布引导与历史记录（已完成）

npm 平台要求**软件包必须已存在于 npm Registry** 方可配置 Trusted Publisher。历史首次发布（`v0.1.0`）已由维护者完成一次性手动授权引导（`npm login --auth-type=web` 与 `npm publish --access public`），后续版本发布无需重复执行手动登录或初始引导。

---

## 2. npm Trusted Publisher 配置（已就绪）

首次发布后已在 npmjs.com 完成 Trusted Publisher 配置，`v0.1.1` 已通过 GitHub Actions OIDC 身份认证完成发布：

- **GitHub Organization / Owner**: `zjm54321`
- **Repository**: `opencode-clear-encrypted`
- **Workflow filename**: `publish.yml`
- **Environment**: `npm`
- **发布模式**：允许 **Direct publish**（2026 年 9 月 3 日之后的 npm 配置默认启用暂存发布，已确认允许直接发布）
- 官方参考文档：
  - [npm Trusted Publishers 文档](https://docs.npmjs.com/trusted-publishers)
  - [npm trust CLI 文档](https://docs.npmjs.com/cli/v12/commands/npm-trust)

---

## 3. 后续版本发布流程（CI / OIDC）

仓库已完成 Trusted Publisher 配置，日常发布完全通过 GitHub Actions 自动化执行，无需配置 `NODE_AUTH_TOKEN`：

1. **版本更新与提交**：在 `package.json` 中递增版本号并提交至 `main` 分支（常规推送至 `main` 不会触发发布）。
2. **推送版本 Tag**：
   ```sh
   git tag v<version>
   git push origin v<version>
   ```
3. **自动流水线验证与发布**：
   - 工作流仅在发布任务中声明 `contents: read` 与 `id-token: write` 最小权限。
   - 自动校验推送的 Git Tag 必须严格匹配 `package.json` 中的版本号（即 `v${version}`）。
   - 环境在 Node 24（npm >= 11.5.1）与 Bun 1.4.2 下运行，自动执行 `bun test` 与 `npm pack --dry-run` 校验，并通过 OIDC 生成 Provenance。
   - **历史验证**：`v0.1.1` 已成功通过 GitHub Actions OIDC 完成端到端自动化发布并验证生成 Provenance。后续版本推送对应版本 Tag 后将自动触发发布。
