---
description: "ModelDesk enterprise sign-in, authorized models, and shared resources."
kind: "package-reference"
---

# ModelDesk enterprise account

English | [中文](README.zh.md)

## Summary

The Host plugin owns the saved ModelDesk platform origin and the employee session. It stores them in the `modeldesk-enterprise/session` credential record. The settings client uses the `enterprise` Remote namespace to read and watch session state, manage sign-in, and refresh models. Its state snapshots exclude tokens. The Host registers the `modeldesk` model provider and advertises the employee's authorized catalog in the normal model selector.

Refresh calls share one operation within the Host. The local credential provider holds the record lock during rotation and persistence, so another process can reuse the newly stored token.

## Table of Contents

This guide covers model calls, libraries, MCP and desktop integration.

## Model Experience

The adapter sends text and supported tool calls to the platform's Chat Completions endpoint with the employee's access token. The platform applies model permissions and meters model tokens. The adapter preserves conversation order and reports provider usage and cache hits when present.

With a tool-capable model, the enterprise plugin exposes `search_enterprise_documents` and `read_enterprise_document`. For example, ask “在企业资料库找出差报销规定，并注明资料出处”. Search returns excerpts and document revisions. Reading returns up to 4,000 characters per call with a continuation offset. The model can cite the title and revision. Tool results enter the normal conversation history and model context. There is no background document synchronization.

The desktop profile loads the enterprise plugin. A CLI profile can load it when the package is available in the runtime. For the headless profile, include this patch and run `dsh --profile headless --patch enterprise.patch.yml '<prompt>'`. The profile reads the stored enterprise login from its Harness home.

```yaml
- id: credentials
  disabled: false
- insert:
    - id: modeldesk-enterprise
      name: '@modeldesk/dsh-enterprise'
      inject: [credentials]
```

## Libraries

The Desktop sidebar opens the personal and enterprise libraries. Employees can import and remove their own files, and browse and download the enterprise files granted by ModelDesk. The composer can select files from both libraries in the same message. Selected references store library, document ID, and revision. The adapter resolves them under the current employee session before calling the model, with up to 12 references and 8,000 characters per source in a single message block. Citation links open an authorized text preview in Desktop. Updated or revoked documents require reselection.

## Enterprise MCP

With the employee signed in, the plugin registers `list_enterprise_mcp_services` and one tool per open enterprise MCP tool. Public names follow `mcp__modeldesk-<server id>__<tool name>`, normalized to the function-name contract with a hash suffix when normalization is lossy or the name exceeds 64 characters. The catalog syncs on sign-in, when another process changes the stored session, and every 30 seconds; signing out removes every tool. The platform holds all upstream credentials and re-authorizes every call, so they never reach the client.

Each service carries the usage guide maintained in the admin console: service purpose, tool call examples, write scope, and common errors. `list_enterprise_mcp_services` returns the guide together with tool descriptions and public names; follow it when choosing a tool. Read tools run directly. Write tools ask for approval before executing; when no approval channel is composed the ask is denied and the call fails closed (`the user rejected tool "…"`), for example in a headless run that rejects approvals.

For example, after an admin enables a ticket service's `search_tickets` tool, ask “查一下 TICKET-42 的报销状态”. The model calls `mcp__modeldesk-1__search_tickets` through the platform proxy and only sees the proxied result. Upstream problems surface as tool errors such as “MCP 服务拒绝了访问凭据，请检查认证配置” or “连接 MCP 服务超时，请检查服务地址”; the server README lists the full error catalog.

## Known Limitations and Deferred Work

- The browser plugin contributes the Enterprise settings section when the Host grants access to the enterprise Remote. It subscribes while the section is mounted and polls monthly usage every 30 seconds while signed in. The desktop profile activates the plugin in a subsequent step.

## Dev Note

The desktop control endpoint publishes an atomic handshake in `$DSH_HOME/modeldesk/control.json`. It binds only to IPv4 loopback. The shell must confirm the proposed platform before it posts to the login endpoint. Unix creates the handshake with mode 0600. Windows uses the ACL inherited from the configured Harness home.
