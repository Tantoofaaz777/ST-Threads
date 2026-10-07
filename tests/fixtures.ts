import type { ChatSnapshot, Host, HostContext, Store } from '../src/types'

export const modelOutput = JSON.stringify({ title: 'Who saw that scene?',
  post: { username: 'OP', body: 'Scene discussion', score: 12 },
  conversations: [1, 2, 3].map(id => ({
    root: { id: `c${id}`, username: `viewer${id}`, body: `Comment ${id}`, score: 5 },
    replies: [{ id: `r${id}`, parent_id: `c${id}`, username: `reply${id}`, body: 'I agree!', score: 2 }],
  })) })

export const chat: ChatSnapshot = { key: 'st:origin', name: 'Original chat', messages: [
  { index: 0, name: 'You', role: 'user', content: 'She opened the door.' },
  { index: 1, name: 'Character', role: 'assistant', content: 'He was waiting.' },
] }

export function fixture() {
  let store: unknown
  let current: ChatSnapshot | null = structuredClone(chat)
  const writes: Store[] = []
  let change = () => {}
  const host: Host = {
    async readChat() { return structuredClone(current) },
    listGenerationTargets() { return [{ kind: 'profile', id: 'profile', name: 'Test', model: 'test-model' }] },
    async readStore() { return structuredClone(store) },
    async writeStore(value) { store = structuredClone(value); writes.push(structuredClone(value)) },
    async generate(_profile, _prompt, _tokens, signal, progress) {
      signal.throwIfAborted(); progress(modelOutput); return modelOutput
    },
    subscribe(callback) { change = callback; return () => { change = () => {} } },
  }
  return { host, writes, change: () => change(), setChat(value: ChatSnapshot | null) { current = value },
    setStore(value: unknown) { store = value } }
}

export function context(): HostContext {
  return {
    chatId: 'scene', characterId: 0, groupId: null,
    characters: [{ avatar: 'card.png', name: 'Character' }], groups: [], chatMetadata: { integrity: 'chat-uuid' },
    chat: [{ mes: 'Hidden', is_system: true }, { mes: 'Scene', is_user: true, name: 'You' }],
    extensionSettings: { disabledExtensions: [] }, saveSettingsDebounced() {},
    CONNECT_API_MAP: { claude: { selected: 'openai', source: 'claude' }, kobold: { selected: 'textgenerationwebui' } },
    eventTypes: { CHAT_CHANGED: 'chat_id_changed', MESSAGE_RECEIVED: 'message_received' },
    eventSource: { on() {}, removeListener() {} },
    ConnectionManagerRequestService: {
      getSupportedProfiles() { return [{ id: 'chat-profile', name: 'Claude', api: 'claude', model: 'model' },
        { id: 'text-profile', api: 'kobold' }] },
      async sendRequest() {
        return async function* () { yield { text: 'Hello' }; yield { text: 'Hello world' } }
      },
    },
  }
}
