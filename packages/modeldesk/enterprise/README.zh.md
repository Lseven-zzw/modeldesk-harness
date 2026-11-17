---
description: "ModelDesk enterprise sign-in, authorized models, and shared resources."
kind: "package-reference"
---

# ModelDesk 企业账号

[English](README.md) | 中文

## 概述

Host 插件保存 ModelDesk 平台地址和员工会话，凭据键为 `modeldesk-enterprise/session`。客户端通过 `enterprise` Remote 管理登录、刷新模型和订阅账号状态，状态快照不包含令牌。

## 目录

本页说明模型调用、资料库、MCP 和桌面集成。

## 模型体验

模型适配器使用员工访问令牌调用平台的 Chat Completions 接口。平台执行模型权限校验并记录用量。有工具能力的模型可用 `search_enterprise_documents` 和 `read_enterprise_document` 检索并引用企业文档。

桌面配置默认加载此插件。通过 CLI 使用时，将 `@modeldesk/dsh-enterprise` 加入已启用凭据服务的 profile。CLI 复用 Harness 主目录中的员工会话。

```yaml
- id: credentials
  disabled: false
- insert:
    - id: modeldesk-enterprise
      name: '@modeldesk/dsh-enterprise'
      inject: [credentials]
```

## 资料库

员工可上传和删除个人文件，也可浏览和下载获准访问的企业资料。引用保存资料库、文档 ID 和版本。文档改版或授权被撤回后，旧引用需要重新选择。

## 企业 MCP

登录后插件会同步已授权的 MCP 工具，退出后移除。上游凭据保存在服务器，由服务器逐次校验授权。写工具需要员工确认。

## 已知限制与后续工作

- 账号设置需要 Host 授予 Remote 权限。桌面的登录控制接口仅监听 IPv4 回环地址，控制文件位于 `$DSH_HOME/modeldesk/control.json`。

## 开发备注

打包前重新生成 Typert Remote 产物。
