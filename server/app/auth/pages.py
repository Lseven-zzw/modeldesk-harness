from html import escape
from urllib.parse import quote

from fastapi.responses import HTMLResponse

from app.admin.spa import admin_entry_assets
from app.models import AuthTx
from app.settings import get_settings


def _page(title: str, body: str, *, admin_login: bool = False, assets: str = "") -> HTMLResponse:
    return HTMLResponse(
        f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · ModelDesk</title>
<style>
body:not(.admin-login) {{ background:#f4f7fb; color:#17273a; font:15px/1.55 Inter,"Microsoft YaHei",system-ui,sans-serif; margin:0; padding:24px; }}
body:not(.admin-login) main {{ box-sizing:border-box; max-width:480px; margin:clamp(12px,6vh,70px) auto; background:#fff; border:1px solid #dbe4ef; border-radius:16px; padding:clamp(20px,5vw,36px); box-shadow:0 12px 34px #152b4f0c; }}
body:not(.admin-login) h1 {{ margin:14px 0 18px; font-size:26px; line-height:1.25; }}
body:not(.admin-login) a {{ color:#245ba6; }}
body:not(.admin-login) form, .login-fallback form {{ display:grid; gap:16px; }}
body:not(.admin-login) label, .login-fallback label {{ display:grid; gap:8px; }}
body:not(.admin-login) :is(input,button), .login-fallback :is(input,button) {{ font:inherit; border-radius:8px; border:1px solid #bccbdb; padding:10px 12px; }}
body:not(.admin-login) input {{ background:#fff; color:inherit; }}
body:not(.admin-login) button {{ background:#245ba6; color:#fff; cursor:pointer; border-color:#245ba6; }}
body:not(.admin-login) button[value=deny], body:not(.admin-login) button[value=manual] {{ background:#f0f4f9; color:#17273a; border-color:#dbe4ef; }}
body:not(.admin-login) button:disabled {{ opacity:.6; cursor:default; }}
.auth-brand {{ color:#245ba6; font-weight:700; letter-spacing:-.02em; }}
body.admin-login {{
  box-sizing:border-box; min-height:100vh; min-height:100dvh; margin:0; padding:0;
  display:grid; grid-template-columns:minmax(320px, 1fr) minmax(380px, 1fr);
  background:#fff; color:#18263a;
  font:15px/1.5 "Inter", "Microsoft YaHei", system-ui, sans-serif;
}}
.login-brand {{
  box-sizing:border-box; display:flex; flex-direction:column; gap:32px;
  padding:clamp(28px, 4.6vw, 76px);
  background:#15263f;
  background-image:radial-gradient(ellipse at 100% 0%,#285283 0%,transparent 58%);
  color:#fff;
}}
.login-brand-name {{ font-size:21px; font-weight:700; letter-spacing:-.035em; }}
.login-brand-content {{ width:100%; max-width:520px; margin:auto; }}
.login-brand-title {{
  margin:0; font-size:clamp(28px, 3.6vw, 52px);
  line-height:1.2; font-weight:650; letter-spacing:-.025em;
}}
.login-brand-description {{ max-width:26em; margin:18px 0 0; color:#d7e2ee; }}
.login-capabilities {{ display:grid; gap:16px; margin:28px 0 0; padding:20px 0 0; border-top:1px solid #3b5068; }}
.login-capabilities div {{ padding-left:12px; border-left:2px solid #7299c9; }}
.login-capabilities dt {{ font-weight:650; }}
.login-capabilities dd {{ margin:2px 0 0; color:#bdcddd; font-size:14px; }}
.login-org {{ margin:0; color:#bdcddd; font-size:14px; }}
.login-area {{ display:grid; place-items:center; padding:clamp(24px, 5vw, 64px); }}
.admin-login main {{
  width:100%; max-width:380px; margin:0;
}}
.admin-login h1 {{ margin:0; font-size:30px; line-height:1.25; font-weight:700; }}
.login-intro {{ margin:8px 0 26px; color:#52647a; font-size:14px; }}
.login-fallback form {{ gap:18px; }}
.login-fallback label {{ gap:6px; font-size:14px; font-weight:600; }}
.login-fallback input, .login-fallback button {{ min-height:44px; box-sizing:border-box; }}
.login-fallback input {{
  width:100%; padding:10px 12px; background:#fff; border-color:#8d9aab;
  font-size:16px; font-weight:400;
}}
.login-fallback button {{
  margin-top:4px; padding:10px 16px; background:#28466b; color:#fff;
  border-color:#28466b; font-weight:600;
}}
.login-fallback button:hover {{ background:#1c3454; }}
body :focus-visible {{ outline:2px solid #315f97; outline-offset:3px; }}
.login-fallback [role=alert] {{
  margin:0 0 18px; padding:10px 12px; border:1px solid #f0c7c5;
  border-radius:8px; background:#fff3f2; color:#8f2926;
}}
@media (max-width: 760px) {{
  body.admin-login {{ grid-template-columns:1fr; grid-template-rows:auto 1fr; }}
  .login-brand {{ padding:24px; gap:14px; }}
  .login-brand-content {{ max-width:none; }}
  .login-brand-title {{ font-size:24px; }}
  .login-brand-description {{ margin-top:8px; }}
  .login-capabilities, .login-org {{ display:none; }}
}}
</style>{assets}</head><body class="{'admin-login' if admin_login else ''}">
{f'''<aside class="login-brand" aria-label="ModelDesk">
<span class="login-brand-name" lang="en">ModelDesk</span>
<div class="login-brand-content">
<p class="login-brand-title">管理企业 AI 模型与技能</p>
<p class="login-brand-description">接入模型、发布企业技能，并为员工配置使用范围和额度。</p>
<dl class="login-capabilities">
<div><dt>模型接入与开放</dt><dd>配置模型，决定向哪些员工开放。</dd></div>
<div><dt>企业技能库</dt><dd>发布技能版本，按员工、部门或用户组同步。</dd></div>
<div><dt>额度与用量</dt><dd>设置 Token 额度，按月查看用量和调用记录。</dd></div>
</dl>
</div>
<p class="login-org">{escape(get_settings().org_name)}</p>
</aside><div class="login-area">''' if admin_login else ''}
<main>
{'' if admin_login else '<span class="auth-brand" lang="en">ModelDesk</span>'}
<h1>{title}</h1>{body}</main>{'</div>' if admin_login else ''}</body></html>""",
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )


def render_login_page(next_url: str, csrf: str, error: str | None = None) -> HTMLResponse:
    notice = f'<p role="alert">{escape(error)}</p>' if error else ""
    fallback = f"""<div class="login-fallback">{notice}<form method="post" action="/admin/login">
<input type="hidden" name="next" value="{escape(next_url)}">
<input type="hidden" name="csrf" value="{escape(csrf)}">
<label>账号<input name="username" autocomplete="username" required></label>
<label>密码<input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit">登录</button></form></div>"""
    assets = ""
    content = fallback
    if entry := admin_entry_assets():
        script, style = entry
        assets = f'<link rel="stylesheet" href="{style}"><script type="module" src="{script}"></script>'
        content = (
            f'<div id="admin-login-form" data-next="{escape(next_url)}" '
            f'data-csrf="{escape(csrf)}" data-error="{escape(error or "")}"></div>'
            f'<noscript>{fallback}</noscript>'
        )
    return _page(
        "管理后台登录",
        f'<p class="login-intro">使用管理员分配的账号登录 ModelDesk。</p>{content}',
        admin_login=True,
        assets=assets,
    )


def render_desktop_launch_page(origin: str) -> HTMLResponse:
    link = "modeldesk://login?server=" + quote(origin, safe="")
    return _page(
        "在桌面客户端中登录",
        f'<p>打开桌面客户端，然后确认要登录的平台地址。</p><p><a href="{escape(link)}">打开客户端</a></p>',
    )


def render_desktop_login_page(tx: AuthTx, csrf: str) -> HTMLResponse:
    return _page(
        "授权桌面端登录",
        f"""<p>组织：{escape(get_settings().org_name)}</p>
<p>设备：{escape(tx.device_name or "未知设备")}</p>
<p>版本：{escape(tx.client_version or "未知版本")}</p>
<form id="authorization" data-auth-id="{escape(tx.id)}" data-csrf="{escape(csrf)}">
<button type="submit" value="allow">授权登录</button>
<button type="submit" value="deny">拒绝</button>
<button type="submit" value="manual">授权并显示一次性票据</button>
<div id="manual-ticket" hidden>
  <label>一次性授权票据<input id="ticket-value" readonly autocomplete="off"></label>
  <p>请复制票据，回到桌面客户端的企业账号页粘贴。</p>
</div>
<p id="feedback" role="alert"></p></form>
<script>
const form = document.querySelector('#authorization');
form.addEventListener('submit', async (event) => {{
  event.preventDefault();
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(button => button.disabled = true);
  const authId = form.dataset.authId;
  const choice = event.submitter?.value;
  if (!choice) return;
  try {{
    const response = await fetch('/api/v1/modeldesk/authorize', {{
      method: 'POST',
      headers: {{'Content-Type': 'application/json', 'X-CSRF-Token': form.dataset.csrf}},
      body: JSON.stringify({{auth_id: authId, decision: choice === 'manual' ? 'allow' : choice}})
    }});
    if (!response.ok) throw new Error();
    const grant = await response.json();
    if (choice === 'manual' && grant.identity_ticket) {{
      const ticket = document.querySelector('#ticket-value');
      ticket.value = grant.identity_ticket;
      document.querySelector('#manual-ticket').hidden = false;
      ticket.focus();
      ticket.select();
      return;
    }}
    const callback = new URL(grant.redirect_uri);
    callback.searchParams.set('auth_id', authId);
    callback.searchParams.set('state', grant.state);
    if (grant.error) callback.searchParams.set('error', grant.error);
    else callback.searchParams.set('identity_ticket', grant.identity_ticket);
    window.location.assign(callback);
  }} catch {{
    document.querySelector('#feedback').textContent = '授权失败，请回到桌面端重新发起登录。';
  }}
}});
</script>""",
    )
