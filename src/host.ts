import type { ChatSnapshot, GenerationResponse, GenerationTarget, Host, HostContext, ProxyPreset, Store, TTHost } from './types'
import { readHostProxyPresets, savedModelPayload, savedModels } from './models'

const NAMESPACE = 'st_threads'

function liveKey(context: HostContext): string | null {
  if (!context.chatId) return null
  if (context.groupId) return JSON.stringify(['group', context.groupId, context.chatId])
  const character = context.characters?.[context.characterId ?? -1]
  if (!character?.avatar) return null
  return JSON.stringify(['character', character.avatar, context.chatMetadata?.integrity || context.chatId])
}

export function createHost(getContext: () => HostContext, tt?: TTHost,
  readProxies: () => Promise<ProxyPreset[]> = readHostProxyPresets): Host {
  // Choose the storage backend once for the session; never silently fall back on an I/O error.
  const storage = tt?.api?.extension?.store
  return {
    async readChat(): Promise<ChatSnapshot | null> {
      const context = getContext()
      const identity = liveKey(context)
      if (!identity) return null
      const group = context.groups?.find(item => item.id === context.groupId)
      const character = context.characters?.[context.characterId ?? -1]
      const messages = context.chat.flatMap((item, index) => {
        if (!item || item.is_system || typeof item.mes !== 'string' || !item.mes.trim()) return []
        return [{ index, name: item.name || (item.is_user ? 'You' : 'Character'),
          role: item.is_user ? 'user' as const : 'assistant' as const, content: item.mes }]
      })
      const stable = tt?.api?.chat ? await tt.api.chat.current.handle().stableId() : identity
      if (liveKey(getContext()) !== identity) throw new Error('The chat changed while loading. Refresh the list.')
      return { key: `${tt ? 'tt' : 'st'}:${context.groupId ? 'group' : 'character'}:${stable}`,
        name: `${group?.name || character?.name || 'Chat'} · ${context.chatId}`, messages }
    },
    listGenerationTargets(): GenerationTarget[] {
      const context = getContext()
      const service = context.ConnectionManagerRequestService
      if (context.extensionSettings.disabledExtensions?.includes('connection-manager')) {
        throw new Error('Enable Connection Manager to choose a saved model or connection profile.')
      }
      const models: GenerationTarget[] = tt && context.ChatCompletionService
        ? savedModels(context).map(item => ({ kind: 'model', id: item.id, name: item.name || item.model, model: item.model })) : []
      const profiles: GenerationTarget[] = (service?.getSupportedProfiles() || [])
        .filter(item => item.api && context.CONNECT_API_MAP?.[item.api]?.selected === 'openai')
        .map(item => ({ kind: 'profile', id: item.id, name: item.name || item.id, model: item.model || '' }))
      return [...models, ...profiles]
    },
    async readStore(): Promise<unknown> {
      if (storage) {
        const result = await storage.tryGetJson({ namespace: NAMESPACE, key: 'state' })
        return result.found ? result.value : undefined
      }
      return structuredClone(getContext().extensionSettings[NAMESPACE])
    },
    async writeStore(store: Store): Promise<void> {
      if (storage) {
        await storage.setJson({ namespace: NAMESPACE, key: 'state', value: store })
      } else {
        const context = getContext()
        context.extensionSettings[NAMESPACE] = structuredClone(store)
        context.saveSettingsDebounced()
      }
    },
    async generate(target, prompt, maxTokens, signal, progress): Promise<string> {
      const context = getContext()
      signal.throwIfAborted()
      if (!this.listGenerationTargets().some(item => item.id === target.id && item.kind === target.kind)) {
        throw new Error('Select an available saved model or Chat Completion profile, then refresh this panel.')
      }
      let output: GenerationResponse
      if (target.kind === 'model') {
        const model = savedModels(context).find(item => item.id === target.id)!
        const payload = await savedModelPayload(model, context, prompt, maxTokens, signal, readProxies)
        signal.throwIfAborted()
        output = await context.ChatCompletionService!.processRequest(payload, {}, true, signal)
      } else {
        output = await context.ConnectionManagerRequestService!.sendRequest(target.id,
          [{ role: 'user', content: prompt }], maxTokens,
          { stream: true, signal, extractData: true, includePreset: true })
      }
      let text = ''
      if (typeof output === 'function') {
        for await (const chunk of output()) {
          signal.throwIfAborted()
          if (typeof chunk.text === 'string') { text = chunk.text; progress(text) }
        }
      } else if (typeof output?.content === 'string') {
        text = output.content
        progress(text)
      }
      signal.throwIfAborted()
      if (!text.trim()) throw new Error('The model returned an empty response.')
      return text
    },
    subscribe(handler): () => void {
      const context = getContext()
      const names = ['CHAT_CHANGED', 'CHAT_RENAMED', 'CHAT_DELETED', 'GROUP_CHAT_DELETED',
        'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED',
        'MODEL_TARGET_CREATED', 'MODEL_TARGET_UPDATED', 'MODEL_TARGET_DELETED',
        'CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED']
      const events = [...new Set(names.map(name => context.eventTypes[name]).filter(Boolean))]
      for (const event of events) context.eventSource.on(event, handler)
      return () => { for (const event of events) context.eventSource.removeListener(event, handler) }
    },
  }
}
