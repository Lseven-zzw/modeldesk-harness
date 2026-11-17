import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ModelDeskMark, ModelDeskName } from './ModelDeskBrand.tsx'
import { EnterpriseToolsIcon, EnterpriseToolsPage, EnterpriseToolsPicker } from './EnterpriseToolsPage.tsx'
import { EnterpriseSection } from './EnterpriseSection.tsx'

import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { LibraryPage, LibraryPicker, LibraryReferenceNode, LibrarySidebarIcon, openLibraryReference } from './LibraryPicker.tsx'

import { libraryReferenceSource } from '../library-reference.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    'modeldesk-library': { label: string; ref: string }
  }
}

const libraryRule: UserTextRule<'modeldesk-library'> = {
  id: libraryReferenceSource,
  order: 25,
  match(text, from) {
    const links = /\[([^\r\n\[\]]+)\]\(modeldesk-document:\/\/(personal|enterprise)\/(\d+)\/(\d+)\)/g
    links.lastIndex = from
    const match = links.exec(text)
    if (!match) return undefined
    const [raw, label, library, id, revision] = match
    return { id: libraryReferenceSource, start: match.index, end: match.index + raw.length,
      data: { label: label ?? '', ref: `${library}:${id}:${revision}` } }
  },
}

const panel = 'modeldesk-library' as MainPanelId

export const inject = ['slots', 'remote', 'remote.enterprise', 'remoteAccess', 'inputTriggers', 'uiConversation']

/** Register the settings section while the Host serves the enterprise account. */
export function apply(ctx: Context): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.register({ name: 'sidebar.brand.mark', priority: -10 }, ModelDeskMark))
  ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.register({ name: 'sidebar.brand.name', priority: -10 }, ModelDeskName))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark', priority: -10 }, ModelDeskMark))
  ctx.slots.inject('conversation.hero.brand.name', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.name', priority: -10 }, ModelDeskName))
  ctx.remoteAccess.whenAccess('enterprise/listLibrary', function* () {
    yield ctx.uiConversation.userText.register(libraryRule)
    yield ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
      name: 'conversation.user.text.node', key: libraryReferenceSource, priority: 100,
    }, LibraryReferenceNode))
    yield ctx.inputTriggers.registerSource({
      trigger: '@',
      name: libraryReferenceSource,
      async candidates() { return [] },
      onPick() { return undefined },
      openReference(_session, { ref }) {
        const match = /\(modeldesk-document:\/\/(personal|enterprise)\/(\d+)\/(\d+)\)$/.exec(ref)
        if (!match) return false
        openLibraryReference(`${match[1]}:${match[2]}:${match[3]}`)
        return true
      },
      codec: { clipboardText: ref => ref, serialize: ref => Promise.resolve(ref) },
    })
    const library = () => ({ remote: ctx.remote.enterprise })
    yield ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
      name: 'conversation.input.left', id: 'modeldesk-library', order: 10, inject: library,
    }, LibraryPicker))
    yield ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: panel, inject: library,
    }, LibraryPage))
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: panel, order: 11, label: () => '资料库', inject: library,
    }, LibrarySidebarIcon))
  })
  ctx.remoteAccess.whenAccess('enterprise/listCapabilities', function* () {
    yield ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
      name: 'conversation.input.left', id: 'modeldesk-enterprise-tools', order: 11,
      inject: () => ({ remote: ctx.remote.enterprise }),
    }, EnterpriseToolsPicker))
    const key = 'modeldesk-enterprise-tools' as MainPanelId
    yield ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key, inject: () => ({ remote: ctx.remote.enterprise }),
    }, EnterpriseToolsPage))
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: key, order: 12, label: () => '企业技能与 MCP',
    }, EnterpriseToolsIcon))
  })
  ctx.remoteAccess.whenAccess('enterprise/watch', () => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section', id: 'enterprise', label: '企业', order: -9,
      inject: () => ({ remote: ctx.remote }),
    }, EnterpriseSection),
  ))
}
