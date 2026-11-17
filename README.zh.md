# ModelDesk Harness

[English](README.md) | 中文

ModelDesk Harness 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的自托管 Agent 工作台。员工通过桌面端调用获准使用的模型，访问共享技能、资料和 MCP 服务。管理员通过网页管理台配置模型权限和额度，并查看用量。

**项目状态** · 源码预览。GitHub CI 覆盖服务端、全新 MySQL 5.7 库迁移和管理台。桌面端需从源码构建。当前预览版暂不提供签名安装包或旧部署迁移。

<a id="run"></a>
## 启动服务端与管理台

1. 安装带 Compose 插件的 Docker。克隆仓库，将 `server/.env.example` 复制为 `server/.env`。

   ```sh
   git clone https://github.com/Lseven-zzw/modeldesk-harness.git
   cd modeldesk-harness/server
   cp .env.example .env
   ```

2. 启动前在 `server/.env` 中填写下列配置。

   | 配置项 | 取值 |
   | --- | --- |
   | `MYSQL_ROOT_PASSWORD`、`MYSQL_PASSWORD` | 两个不同的数据库密码 |
   | `MODELDESK_COMPOSE_DATABASE_URL` | `mysql+pymysql://modeldesk:<URL-encoded MYSQL_PASSWORD>@mysql:3306/modeldesk?charset=utf8mb4`，连接串中的密码部分须经过 URL 编码 |
   | `MODELDESK_SECRET_KEY`、`MODELDESK_MASTER_KEY` | 独立生成会话签名密钥和 32 字节随机主密钥，主密钥使用 URL 安全的 Base64 编码 |
   | `MODELDESK_SEED_ADMIN_PASSWORD`、`MODELDESK_SEED_EMPLOYEE_PASSWORD` | 分别设置 12–128 字符的不同密码。两个演示员工共用员工初始化密码。 |
   | `MODELDESK_BASE_URL` | 本机测试使用 `http://127.0.0.1:8080`。远程访问时使用桌面端可达的 HTTPS 源地址。 |

3. 使用全新数据库启动服务，初始化账号并检查服务状态。

   ```sh
   docker compose up -d --build --wait
   docker compose exec server python -m app.seed
   curl -fsS http://127.0.0.1:8080/healthz
   ```

4. 打开 `http://127.0.0.1:8080/admin/login`，以 `admin` 登录。配置 OpenAI 兼容的上游模型渠道，启用模型并授权给员工。用 `zhang.san` 或 `li.si` 和员工初始化密码测试桌面登录。正式部署时停用演示账号。

数据库、权限、存储和解析工具的细节见[服务端指南](server/README.zh.md)。

<a id="run-from-source"></a>
## 从源码启动桌面端

使用 Node.js 24.9 或更新版本，以及 [package.json](package.json) 固定的 pnpm 版本。在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm run dev:desktop
```

在桌面端账号设置中填写 `MODELDESK_BASE_URL` 的源地址，并通过浏览器登录。确认获准使用的模型出现在选择器中，再发送一条测试消息。平台工具链要求见[桌面打包说明](apps/desktop/packaging/README.zh.md)。

## 贡献与支持

通过 [GitHub Issues](https://github.com/Lseven-zzw/modeldesk-harness/issues) 报告问题或提出建议。提交 PR 前阅读[贡献指南](CONTRIBUTING.zh.md)，安全漏洞请按[安全政策](SECURITY.md)私下报告。

## 许可证

源代码按 [MIT 许可证](LICENSE) 发布。第三方依赖许可见 [Third-Party Notices](THIRD_PARTY_NOTICES.md)。
