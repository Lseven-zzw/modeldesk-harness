import { useEffect, useState } from 'react'
import { CircleAlert, LoaderCircle } from 'lucide-react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import Shell, { adminNavigation } from '@/components/Shell'
import ConfirmationProvider from '@/components/ConfirmationProvider'
import { Button } from '@/components/ui/button'
import RolesPage from '@/pages/RolesPage'
import UsagePage from '@/pages/UsagePage'
import ModelsPage from '@/pages/ModelsPage'
import EmployeesPage from '@/pages/EmployeesPage'
import DepartmentsPage from '@/pages/DepartmentsPage'
import AuthorizationAuditPage from '@/pages/AuthorizationAuditPage'
import UserGroupsPage from '@/pages/UserGroupsPage'
import EnterpriseSkillsPage from '@/pages/EnterpriseSkillsPage'
import EnterpriseDocumentsPage from '@/pages/EnterpriseDocumentsPage'
import EnterpriseMcpPage from '@/pages/EnterpriseMcpPage'
import { api, setUnauthorizedHandler, type SessionInfo } from '@/lib/api'

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setUnauthorizedHandler(() => {
      const next = encodeURIComponent(window.location.pathname)
      window.location.assign(`/admin/login?next=${next}`)
    })
    api.session().then(setSession).catch((caught: Error) => setError(caught.message))
  }, [])

  if (error !== null || session === null) return <main className="grid min-h-dvh place-items-center px-4">
    <div className="console-panel flex w-full max-w-sm flex-col items-center gap-3 p-6 text-center">
      {error !== null ? <>
        <CircleAlert className="text-destructive" aria-hidden="true" />
        <p role="alert" className="text-sm text-destructive">无法加载管理台：{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>重新加载</Button>
      </> : <>
        <LoaderCircle className="text-primary motion-safe:animate-spin" aria-hidden="true" />
        <p role="status" className="text-sm text-muted-foreground">正在加载管理台…</p>
      </>}
    </div>
  </main>

  const navigation = adminNavigation(session.permissions, session.model_permissions)
  const permitted = (path: string, page: React.ReactNode) => navigation.some((item) => item.to === path)
    ? page
    : <p className="console-panel p-6 text-muted-foreground" role="status">你没有访问此页面的权限。</p>

  return (
    <ConfirmationProvider><BrowserRouter basename="/admin">
      <Routes>
        <Route element={<Shell session={session} />}>
          <Route index element={<Navigate to={navigation[0]?.to ?? "/unavailable"} replace />} />
          <Route path="employees" element={permitted("/employees", <EmployeesPage permissions={session.permissions} />)} />
          <Route path="departments" element={permitted("/departments", <DepartmentsPage canManage={session.permissions.includes('roles.manage')} />)} />
          <Route path="models" element={permitted("/models", <ModelsPage permissions={session.permissions} modelPermissions={session.model_permissions} />)} />
          <Route path="usage" element={permitted("/usage", <UsagePage canReadModels={session.permissions.includes("models.read")} />)} />
          <Route path="roles" element={permitted("/roles", <RolesPage />)} />
          <Route path="user-groups" element={permitted("/user-groups", <UserGroupsPage />)} />
          <Route path="enterprise-skills" element={permitted("/enterprise-skills", <EnterpriseSkillsPage permissions={session.permissions} />)} />
          <Route path="enterprise-documents" element={permitted("/enterprise-documents", <EnterpriseDocumentsPage canManage={session.permissions.includes('documents.manage')} />)} />
          <Route path="enterprise-mcp" element={permitted("/enterprise-mcp", <EnterpriseMcpPage canManage={session.permissions.includes('mcp.manage')} />)} />
          <Route path="authorization-audit" element={permitted("/authorization-audit", <AuthorizationAuditPage />)} />
          <Route path="*" element={<p className="console-panel p-6 text-muted-foreground" role="status">此页面暂未开放。</p>} />
        </Route>
      </Routes>
    </BrowserRouter></ConfirmationProvider>
  )
}
