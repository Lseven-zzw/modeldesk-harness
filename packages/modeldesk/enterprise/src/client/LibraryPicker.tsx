import { useEffect, useState } from 'react'
import type { ClientRemote, DocumentLibrary, LibraryDocument, LibraryDocumentText } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, FileTypeIcon, IconDownloadOutlineRegular, IconFolderOpenOutlineRegular, IconSearchOutlineRegular, Modal, ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReferenceInsert, UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { libraryReferenceLink, libraryReferenceSource } from '../library-reference.ts'
import css from './LibraryPicker.module.css'

interface Selection { library: DocumentLibrary; file: LibraryDocument }
type LibraryRemote = ClientRemote['enterprise']
const key = ({ library, file }: Selection) => `${library}:${file.id}`
const label = (library: DocumentLibrary) => library === 'personal' ? '个人资料库' : '企业资料库'

function fileType(file: LibraryDocument): string {
  return /\.([a-z0-9]{1,6})$/i.exec(file.filename ?? '')?.[1]?.toUpperCase() ?? 'MD'
}

function fileMeta(file: LibraryDocument): string {
  const status = { pending: '等待解析', failed: '解析失败', original_only: '仅原件', truncated: '正文已截断' }[file.parse_status ?? '']
  return [fileType(file), status, `版本 ${file.revision}`].filter(Boolean).join(' · ')
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function decodeFile(data: string): Uint8Array<ArrayBuffer> {
  const bytes = atob(data)
  return Uint8Array.from(bytes, character => character.charCodeAt(0))
}

function LibraryContent({ remote, add, close }: {
  remote: LibraryRemote
  add?: (references: readonly ReferenceInsert[]) => boolean
  close?: () => void
}) {
  const [library, setLibrary] = useState<DocumentLibrary>('personal')
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState('')
  const [items, setItems] = useState<readonly LibraryDocument[]>()
  const [cursor, setCursor] = useState<number | null>(null)
  const [selected, setSelected] = useState<Selection[]>([])
  const [preview, setPreview] = useState<LibraryDocumentText>()
  const [mediaUrl, setMediaUrl] = useState<string>()
  useEffect(() => () => { if (mediaUrl) URL.revokeObjectURL(mediaUrl) }, [mediaUrl])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '资料库操作失败')
    } finally {
      setBusy(false)
    }
  }

  async function load(target: DocumentLibrary, term: string, before?: number) {
    const page = value(await remote.listLibrary(target, term.trim(), before ?? null))
    setItems(current => before === undefined ? page.items : [...(current ?? []), ...page.items])
    setCursor(page.next_before)
  }

  useEffect(() => {
    let active = true
    setBusy(true)
    void remote.listLibrary('personal', '', null).then(value).then(page => {
      if (!active) return
      setItems(page.items)
      setCursor(page.next_before)
    }).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : '资料库操作失败')
    }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [remote])

  function selectLibrary(target: DocumentLibrary) {
    setLibrary(target)
    setItems(undefined)
    setCursor(null)
    setPreview(undefined)
    setMediaUrl(undefined)
    setQuery('')
    setSearched('')
    void run(() => load(target, ''))
  }

  async function upload(files: File[]) {
    try {
      for (const file of files) {
        if (file.size > 16 * 1024 * 1024) throw new Error(`${file.name} 超过 16 MiB`)
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () => reject(new Error(`无法读取 ${file.name}`))
          reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
          reader.readAsDataURL(file)
        })
        value(await remote.uploadLibraryFile(file.name, base64))
      }
    } finally {
      setQuery('')
      setSearched('')
      await load('personal', '')
    }
  }

  async function readOriginal(file: LibraryDocument) {
    const current = file.parse_status === 'pending'
      ? value(await remote.readLibrary(library, file.id, null))
      : file
    return decodeFile(value(await remote.downloadLibraryFile(library, current.id, current.revision)))
  }

  async function download(file: LibraryDocument) {
    const data = await readOriginal(file)
    const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }))
    const link = document.createElement('a')
    link.href = url
    link.download = file.filename ?? file.title
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 15_000)
  }

  return <div className={css.content} data-mode={add ? 'picker' : 'page'}>
    <div className={css.controls}>
      <div className={css.toolbar}>
        <div className={css.scopes} role="group" aria-label="资料来源">
          {(['personal', 'enterprise'] as const).map(scope =>
            <button type="button" key={scope} aria-pressed={library === scope} disabled={busy}
              onClick={() => selectLibrary(scope)}>{label(scope)}</button>)}
        </div>
        {library === 'personal' && <label className={css.upload}>
          <span aria-hidden="true">＋</span> 上传文件
          <input type="file" multiple disabled={busy} aria-label="上传个人资料" onChange={event => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            if (files.length) void run(() => upload(files))
          }} />
        </label>}
      </div>
      <form className={css.search} onSubmit={event => {
        event.preventDefault()
        void run(async () => {
          setPreview(undefined)
          setMediaUrl(undefined)
          await load(library, query)
          setSearched(query.trim())
        })
      }}>
        <IconSearchOutlineRegular size={17} />
        <input data-modal-autofocus aria-label="搜索资料" placeholder="搜索文件名或正文" maxLength={120}
          value={query} onChange={event => setQuery(event.currentTarget.value)} />
        <button type="submit" disabled={busy}>搜索</button>
      </form>
    </div>
    {error && <p className={css.error} role="alert">{error}</p>}
    <div className={css.grid}>
      <section className={css.list} aria-label="文件列表" aria-busy={busy}>
        <div className={css.columnTitle}>
          <strong>{searched ? '搜索结果' : '文件'}</strong>
          {items?.some(file => file.parse_status === 'pending') && <button type="button" disabled={busy}
            onClick={() => void run(() => load(library, searched))}>刷新解析状态</button>}
          {items && <span>{items.length}{cursor === null ? '' : '+'} 份</span>}
        </div>
        {items?.length === 0 && <div className={css.empty}>
          <IconFolderOpenOutlineRegular size={28} />
          <strong>{searched ? '没有匹配的资料' : '暂无资料'}</strong>
          <span>{searched ? '换个关键词再试试' : library === 'personal' ? '上传文件后可在对话中引用' : '已授权的企业文件会显示在这里'}</span>
        </div>}
        {items === undefined && busy && <div className={css.empty} role="status">正在加载资料…</div>}
        {items?.map(file => {
          const item = { library, file }
          const checked = selected.some(entry => key(entry) === key(item))
          return <div key={file.id} className={css.item} data-active={preview?.id === file.id}>
            {add && <input type="checkbox" checked={checked} aria-label={`选择 ${file.title}`}
              disabled={busy || file.parse_status === 'pending' || (!checked && selected.length >= 12)} onChange={() => setSelected(current =>
                checked ? current.filter(entry => key(entry) !== key(item)) : [...current, item])} />}
            <button type="button" className={css.filename} disabled={busy} onClick={() => void run(async () => {
              setMediaUrl(undefined)
              setPreview(value(await remote.readLibrary(library, file.id, file.parse_status === 'pending' ? null : file.revision)))
            })}>
              <span className={css.fileIcon} aria-hidden="true"><FileTypeIcon path={file.filename ?? `${file.title}.md`} size={20} /></span>
              <span className={css.fileInfo}><strong title={file.title}>{file.title}</strong><small>{fileMeta(file)}</small></span>
            </button>
          </div>
        })}
        {cursor !== null && <button className={css.more} type="button" disabled={busy}
          onClick={() => void run(() => load(library, searched, cursor))}>加载更多</button>}
      </section>
      <div className={css.preview}>
        {preview ? <>
          <div className={css.previewTitle}>
            <span className={css.fileIcon} aria-hidden="true">{fileType(preview)}</span>
            <div><h3>{preview.title}</h3><span>{label(library)} · {fileMeta(preview)}</span></div>
          </div>
          {mediaUrl && (preview.media_type?.startsWith('image/') ? <img src={mediaUrl} alt={preview.title} />
            : preview.media_type?.startsWith('audio/') ? <audio src={mediaUrl} controls />
              : <video src={mediaUrl} controls />)}
          {preview.parse_status === 'truncated' && <p>正文已截断，可下载原件查看全文。</p>}
          {preview.content && preview.format === 'markdown'
            ? <div className={css.markdown}>{preview.content.split('\n').map((line, index) => {
              const heading = /^(#{1,6}) +(.+)$/.exec(line)
              if (heading) return <div key={index} role="heading" aria-level={Math.min(6, heading[1]!.length + 2)} className={css.heading}>{heading[2]}</div>
              return <div key={index}>{line || '\u00a0'}</div>
            })}</div>
            : <pre>{preview.content || (preview.parse_status === 'pending' ? '正在等待正文解析，可先下载原件。'
              : preview.parse_status === 'failed' ? '正文解析失败，可下载原件。' : '该文件暂无可检索正文，可下载原件。')}</pre>}
          <div className={css.toolbar}>
            {preview.media_type && /^(image|audio|video)\//.test(preview.media_type) && !mediaUrl && <button
              type="button" disabled={busy} onClick={() => void run(async () => {
                const data = await readOriginal(preview)
                setMediaUrl(URL.createObjectURL(new Blob([data], { type: preview.media_type ?? '' })))
              })}>预览原件</button>}
            {preview.filename && <button type="button" disabled={busy}
              onClick={() => void run(() => download(preview))}><IconDownloadOutlineRegular size={16} />下载原件</button>}
            {library === 'personal' && <button type="button" disabled={busy} onClick={() => {
              if (!window.confirm(`删除「${preview.title}」？`)) return
              void run(async () => {
                value(await remote.deleteLibraryFile(preview.id))
                setSelected(current => current.filter(item => item.library !== 'personal' || item.file.id !== preview.id))
                setPreview(undefined)
                setMediaUrl(undefined)
                await load('personal', query)
              })
            }}>删除</button>}
          </div>
        </> : <div className={css.empty}><IconFolderOpenOutlineRegular size={30} /><strong>选择文件查看预览</strong></div>}
      </div>
    </div>
    {add && <div className={css.footer}>
      <div className={css.selection}>
        <span>已选 {selected.length} 份</span>
        <div className={css.chips}>{selected.map(item => <button type="button" key={key(item)} disabled={busy}
        onClick={() => setSelected(current => current.filter(entry => key(entry) !== key(item)))}
        aria-label={`移除 ${item.file.title}`} title={`${label(item.library)} · ${item.file.title}`}>{item.file.title} ×</button>)}</div>
      </div>
      <Button disabled={busy || selected.length === 0} onClick={() => void run(async () => {
        const documents = await Promise.all(selected.map(async ({ library: scope, file }) =>
          ({ library: scope, file: value(await remote.readLibrary(scope, file.id, file.revision)) })))
        const references = documents.map(({ library: scope, file }): ReferenceInsert => {
          const label = file.filename ?? file.title
          const ref = libraryReferenceLink(`${scope}:${file.id}:${file.revision}`, label)
          return { source: libraryReferenceSource, ref, label, appearance: 'file', clipboardText: ref }
        })
        if (!add(references)) {
          throw new Error('输入框内容已变化，请关闭后重新选择资料')
        }
        close?.()
      })}>添加到对话</Button>
    </div>}
  </div>
}

/** Open both scoped libraries from the active conversation composer. */
export function LibraryPicker({ remote, inputActions, useInput }: PropsRuntime<'conversation.input.left'> & { remote: LibraryRemote }) {
  const [span, setSpan] = useState<ReturnType<typeof inputActions.captureInsertion>>()
  const locked = useInput(state => state.phase === 'submitting' || state.phase === 'sending')
  return <>
    <Button disabled={locked} onClick={() => setSpan(inputActions.captureInsertion())}><IconFolderOpenOutlineRegular size={16} />资料库</Button>
    <Modal open={span !== undefined} onClose={() => setSpan(undefined)} title="添加资料到对话" closeLabel="关闭"
      className={css.dialog ?? ''}>
      {span && <LibraryContent remote={remote} close={() => setSpan(undefined)}
        add={references => inputActions.insertReferences(references, span)} />}
    </Modal>
  </>
}


/** Browse both libraries independently of a conversation. */
export function LibraryPage({ remote }: { remote: LibraryRemote }) {
  return <section className={css.page}>
    <header className={css.pageHeader}><h1>资料库</h1><p>浏览个人文件和已授权的企业资料</p></header>
    <LibraryContent remote={remote} />
  </section>
}


/** Open a citation with a fresh authorization and version check. */
export function LibrarySidebarIcon({ size, remote }: PropsRuntime<'sidebar.panellist'> & { remote: LibraryRemote }) {
  const [citation, setCitation] = useState<{ title: string; content: string }>()
  useEffect(() => {
    let generation = 0
    function open(url: string) {
      const match = /^modeldesk-document:\/\/(personal|enterprise)\/(\d+)\/(\d+)$/.exec(url)
      if (!match) return
      const request = ++generation
      setCitation({ title: '资料引用', content: '正在检查资料权限…' })
      void remote.readLibrary(match[1] as DocumentLibrary, Number(match[2]), Number(match[3])).then(value)
        .then(file => {
          if (request === generation) setCitation({ title: `${file.title} · 版本 ${file.revision}`, content: file.content || '没有可显示的正文。' })
        }).catch((error: unknown) => {
          if (request === generation) setCitation({ title: '无法打开资料', content: error instanceof Error ? error.message : '资料不存在或不可访问' })
        })
    }
    function click(event: MouseEvent) {
      const link = event.target instanceof Element ? event.target.closest('a') : null
      const url = link?.getAttribute('href') ?? ''
      if (!url.startsWith('modeldesk-document://')) return
      event.preventDefault()
      event.stopPropagation()
      open(url)
    }
    function chip(event: Event) {
      if (event instanceof CustomEvent && typeof event.detail === 'string') open(event.detail)
    }
    document.addEventListener('click', click, true)
    document.addEventListener('modeldesk-document-open', chip)
    return () => {
      generation++
      document.removeEventListener('click', click, true)
      document.removeEventListener('modeldesk-document-open', chip)
    }
  }, [remote])
  return <>
    <IconFolderOpenOutlineRegular size={size} />
    <Modal open={citation !== undefined} onClose={() => setCitation(undefined)} title={citation?.title ?? '资料引用'} closeLabel="关闭"
      className={css.dialog ?? ''}>
      <div className={css.preview}><pre>{citation?.content}</pre></div>
    </Modal>
  </>
}

/** Render a submitted library reference with the native file chip. */
export function LibraryReferenceNode({ node, interactive }: UserTextNodeProps<'modeldesk-library'>) {
  return <ReferenceChip appearance="file" label={node.data.label} title={node.data.label}
    {...interactive ? { onActivate: () => openLibraryReference(node.data.ref) } : {}} />
}

/** Request an authorized preview for a library reference. */
export function openLibraryReference(ref: string): void {
  document.dispatchEvent(new CustomEvent('modeldesk-document-open', {
    detail: `modeldesk-document://${ref.replaceAll(':', '/')}`,
  }))
}
