import { useEffect, useState } from 'react'
import type { ClientRemote, ModelDeskCapabilities } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, IconPluginPinwheelOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './EnterpriseSection.module.css'

/** Sidebar glyph for the employee's enterprise capability catalog. */
export function EnterpriseToolsIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconPluginPinwheelOutlineRegular size={size} />
}

/** Browse capabilities granted to the active employee. */
export function EnterpriseToolsPage({ remote, insert }: {
  remote: ClientRemote['enterprise']
  insert?: (text: string) => boolean
}) {
  const [catalog, setCatalog] = useState<ModelDeskCapabilities>()
  const [error, setError] = useState('')
  const [generation, refresh] = useState(0)
  useEffect(() => {
    let active = true
    void remote.listCapabilities().then(result => {
      if (!active) return
      if (result.ok) setCatalog(result.value)
      else setError(result.error.message)
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : '无法加载企业能力')
    })
    return () => { active = false }
  }, [generation, remote])

  function add(text: string) {
    if (insert && !insert(text)) setError('输入框已变化，请关闭后重新选择。')
  }

  return <main className={insert ? css.composerCatalog : css.catalog}>
    <header>
      <h1>企业技能与 MCP</h1>
      <Button variant="outline" disabled={!catalog && !error} onClick={() => {
        setCatalog(undefined)
        setError('')
        refresh(value => value + 1)
      }}>刷新</Button>
    </header>
    {error && <p role="alert" className={css.error}>{error}</p>}
    {!catalog && !error && <p role="status">正在加载…</p>}
    {catalog && !catalog.signedIn && <p>请在「设置 → 企业」登录后查看已授权的技能与工具。</p>}
    {catalog?.signedIn && <>
      <section className={css.section}>
        <h2>企业技能 <small>{catalog.skills.length}</small></h2>
        {catalog.skills.length === 0 && <p className={css.secondary}>暂无已发布且向当前账号开放的技能。</p>}
        {catalog.skills.map(skill => <article key={skill.code} className={css.card}>
          <h3>{skill.code}</h3>
          {skill.description && <p>{skill.description}</p>}
          <p className={css.secondary}>版本 {skill.revision} · 在对话中输入 <code>/{skill.code}</code></p>
          {insert && <Button variant="outline" onClick={() => add(`/${skill.code} `)}>插入技能命令</Button>}
        </article>)}
      </section>
      <section className={css.section}>
        <h2>企业 MCP <small>{catalog.mcp.length}</small></h2>
        {catalog.mcp.length === 0 && <p className={css.secondary}>暂无向当前账号开放的 MCP 服务。</p>}
        {catalog.mcp.map(service => <article key={service.id} className={css.card}>
          <h3>{service.name}</h3>
          {service.description && <p>{service.description}</p>}
          <ul className={css.tools}>
            {service.tools.map(tool => <li key={tool.name}>
              <strong>{tool.name}</strong><small>{tool.access === 'read' ? '只读' : '写入需确认'}</small>
              {tool.description && <p>{tool.description}</p>}
              {insert && <Button variant="outline" onClick={() => add(`请使用企业 MCP「${service.name}」的 ${tool.name} 工具：`)}>加入对话</Button>}
            </li>)}
          </ul>
          {service.guide && <details><summary>使用说明</summary><p className={css.guide}>{service.guide}</p></details>}
        </article>)}
      </section>
    </>}
  </main>
}


/** Choose an enterprise capability without leaving the current conversation. */
export function EnterpriseToolsPicker({ remote, inputActions, useInput }: PropsRuntime<'conversation.input.left'> & {
  remote: ClientRemote['enterprise']
}) {
  const [span, setSpan] = useState<ReturnType<typeof inputActions.captureInsertion>>()
  const locked = useInput(state => state.phase === 'submitting' || state.phase === 'sending')
  return <>
    <Button disabled={locked} onClick={() => setSpan(inputActions.captureInsertion())}>
      <IconPluginPinwheelOutlineRegular size={16} />企业能力
    </Button>
    <Modal open={span !== undefined} title="添加企业能力到对话" closeLabel="关闭"
      className={css.catalogDialog ?? ''} onClose={() => setSpan(undefined)}>
      {span && <EnterpriseToolsPage remote={remote} insert={text => {
        const inserted = inputActions.insertText(text, span)
        if (inserted) setSpan(undefined)
        return inserted
      }} />}
    </Modal>
  </>
}
