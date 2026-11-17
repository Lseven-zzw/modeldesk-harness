import { useEffect, useState } from 'react'
import { BarChart3, BookOpen, Boxes, Building2, ChevronRight, Files, History, LogOut, Menu, Plug, Shield, Users, UsersRound } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import type { SessionInfo } from '@/lib/api'

const organization = '组织管理'
const operations = '资源与运营'
const nav = [
  { to: '/employees', label: '员工管理', group: organization, icon: Users, permissions: ['employees.read'] },
  { to: '/departments', label: '部门管理', group: organization, icon: Building2, permissions: ['employees.read'] },
  { to: '/models', label: '模型与开放范围', group: operations, icon: Boxes, permissions: ['models.read', 'grants.read', 'credits.read'] },
  { to: '/roles', label: '角色与权限', group: organization, icon: Shield, permissions: ['roles.manage'] },
  { to: '/user-groups', label: '用户组', group: organization, icon: UsersRound, permissions: ['roles.manage'] },
  { to: '/authorization-audit', label: '授权审计', group: organization, icon: History, permissions: ['roles.manage'] },
  { to: '/enterprise-skills', label: '企业技能库', group: operations, icon: BookOpen, permissions: ['skills.read'] },
  { to: '/enterprise-documents', label: '企业资料库', group: operations, icon: Files, permissions: ['documents.read'] },
  { to: '/enterprise-mcp', label: '企业 MCP', group: operations, icon: Plug, permissions: ['mcp.read'] },
  { to: '/usage', label: '用量分析', group: operations, icon: BarChart3, permissions: ['usage.read'] },
]

export function adminNavigation(permissions: string[], modelPermissions: Record<string, string[]> = {}) {
  return nav.filter((item) => item.permissions.some((permission) => permissions.includes(permission))
    || (item.to === '/models' && Object.keys(modelPermissions).length > 0))
}

function Brand() {
  return <div className="flex items-center gap-3">
    <span aria-hidden="true" className="console-mark"><Boxes size={19} /></span>
    <span className="text-lg font-semibold tracking-tight" lang="en">ModelDesk</span>
  </div>
}

function Sidebar({ navigation, orgName, onNavigate }: {
  navigation: ReturnType<typeof adminNavigation>
  orgName: string
  onNavigate?: () => void
}) {
  return <>
    <div className="flex h-[72px] shrink-0 items-center border-b border-white/10 px-5"><Brand /></div>
    <nav aria-label="管理台导航" className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 py-5">
      {[organization, operations].map((group) => {
        const items = navigation.filter((item) => item.group === group)
        if (!items.length) return null
        return <div key={group}>
          <p className="mb-2 px-3 text-xs font-medium text-slate-400">{group}</p>
          <div className="flex flex-col gap-1">
            {items.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} onClick={onNavigate} className="console-nav-link">
                <Icon size={17} aria-hidden="true" />
                <span>{label}</span>
              </NavLink>
            ))}
          </div>
        </div>
      })}
    </nav>
    <div className="flex min-h-16 shrink-0 items-center gap-3 border-t border-white/10 px-5 text-sm text-slate-300">
      <Building2 size={17} className="shrink-0 text-slate-400" aria-hidden="true" />
      <span className="truncate" title={orgName}>{orgName}</span>
    </div>
  </>
}

export default function Shell({ session }: { session: SessionInfo }) {
  const [logoutError, setLogoutError] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const { pathname } = useLocation()
  const navigation = adminNavigation(session.permissions, session.model_permissions)
  const current = navigation.find((item) => item.to === pathname.replace(/\/$/, ''))
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)')
    const closeOnDesktop = () => { if (desktop.matches) setMobileOpen(false) }
    desktop.addEventListener('change', closeOnDesktop)
    return () => desktop.removeEventListener('change', closeOnDesktop)
  }, [])

  async function logout(): Promise<void> {
    setLoggingOut(true)
    setLogoutError(false)
    try {
      const response = await fetch('/admin/logout', {
        method: 'POST',
        headers: { 'X-CSRF-Token': session.csrf_token },
        credentials: 'same-origin',
      })
      if (!response.ok && response.status !== 401) throw new Error()
      window.location.assign('/admin/login')
    } catch {
      setLogoutError(true)
      setLoggingOut(false)
    }
  }

  return (
    <div className="min-h-full md:grid md:grid-cols-[224px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)]">
      <a href="#admin-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2">跳到主要内容</a>
      <aside className="console-sidebar sticky top-0 hidden h-dvh flex-col md:flex">
        <Sidebar navigation={navigation} orgName={session.org_name} />
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-10 border-b bg-card">
          <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
                <DialogTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" className="-ml-1 shrink-0 md:hidden" aria-label="打开管理台导航">
                    <Menu aria-hidden="true" />
                  </Button>
                </DialogTrigger>
                <DialogContent className="console-sidebar left-0 top-0 flex h-dvh max-h-dvh w-[min(84vw,19rem)] max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-[hsl(var(--sidebar))] p-0 text-white sm:p-0 md:hidden">
                  <DialogTitle className="sr-only">管理台导航</DialogTitle>
                  <DialogDescription className="sr-only">选择要打开的管理页面。</DialogDescription>
                  <Sidebar navigation={navigation} orgName={session.org_name} onNavigate={() => setMobileOpen(false)} />
                </DialogContent>
              </Dialog>
              <div className="flex min-w-0 items-center gap-2 text-sm">
                {current && <><span className="hidden whitespace-nowrap text-muted-foreground sm:inline">{current.group}</span>
                  <ChevronRight size={14} aria-hidden="true" className="hidden shrink-0 text-muted-foreground sm:block" /></>}
                <span className="truncate font-medium">{current?.label ?? '管理台'}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              <span aria-hidden="true" className="grid size-8 place-items-center rounded-full border border-primary/20 bg-primary/5 font-semibold text-primary">
                {session.user.display_name.slice(0, 1)}
              </span>
              <span className="hidden max-w-36 truncate text-sm font-medium sm:inline" title={session.user.display_name}>{session.user.display_name}</span>
              <Button type="button" variant="ghost" size="sm" onClick={logout} disabled={loggingOut} aria-label="退出登录">
                <LogOut aria-hidden="true" /><span className="hidden lg:inline">退出</span>
              </Button>
            </div>
          </div>
        </header>
        <main id="admin-main" tabIndex={-1} className="admin-content mx-auto max-w-[1600px] px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-9">
          {logoutError && <p role="alert" className="mb-4 text-destructive">退出失败，请重试。</p>}
          <Outlet />
        </main>
      </div>
    </div>
  )
}
