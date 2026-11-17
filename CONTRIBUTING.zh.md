# 为 ModelDesk Harness 贡献代码

[English](CONTRIBUTING.md) | 中文

通过 [GitHub Issues](https://github.com/Lseven-zzw/modeldesk-harness/issues) 报告问题或提出建议。请提供受影响的提交或版本、操作系统、复现步骤和预期结果，并从日志和示例中移除凭据及私有数据。安全漏洞请按[安全政策](SECURITY.md)报告。

## 提交 Pull Request

1. 从 `main` 创建分支。没有写权限时，先 fork 仓库。
2. 让每个 PR 聚焦于一项改动。安装或使用方式发生变化时，同步更新两种语言的 README。
3. 运行覆盖改动范围的检查，向 `main` 提交 PR，并说明改动和已运行的检查。
4. 等待 `server` 和 `admin` 检查通过。处理评审讨论，并在 `main` 有新提交时更新分支。

## 本地检查

```sh
cd server
uv sync --locked
uv run --locked pytest -q
cd admin
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

改动涉及桌面端或共享 TypeScript 时，在仓库根目录运行 `pnpm install --frozen-lockfile` 和 `pnpm run build`。
