# ModelDesk Harness

[English](README.md) | 中文

ModelDesk Harness 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建的自托管 Agent 工作台。项目提供桌面客户端和管理台，可管理员工访问权限、模型渠道和用量，并提供企业技能、资料库与 MCP 服务。

<a id="run"></a>
## 启动服务端与管理台

1. 将 `server/.env.example` 复制为 `server/.env`，配置 MySQL 密码、数据库连接串、应用密钥和管理员初始化密码。配置格式见[服务端指南](server/README.zh.md)。
2. 在 `server/` 目录运行 `docker compose up -d --build --wait`。
3. 运行一次 `docker compose exec server python -m app.seed`，然后访问 `http://127.0.0.1:8080/admin/login` 登录。
4. 在管理台配置模型渠道并授予员工访问权限，再连接桌面客户端。

首版采用新的数据库和桌面应用身份。首次部署请使用全新的数据存储。

<a id="run-from-source"></a>
## 启动桌面开发环境

使用 Node.js 24.9 或更新版本，以及 [package.json](package.json) 固定的 pnpm 版本。在仓库根目录运行 `pnpm install --frozen-lockfile` 和 `pnpm run dev:desktop`，然后在桌面账号设置中配置 ModelDesk 服务地址。各平台打包要求见[桌面打包说明](apps/desktop/packaging/README.zh.md)。

## 许可证

源代码按 [MIT 许可证](LICENSE) 发布。第三方依赖许可见 [Third-Party Notices](THIRD_PARTY_NOTICES.md)。
