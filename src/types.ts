import type { ThreadverseFeed } from './core/shared'

export interface SceneMessage {
  index: number
  role: 'user' | 'assistant'
  name: string
  content: string
}
export interface ChatSnapshot {
  key: string
  name: string
  messages: SceneMessage[]
}
export interface Profile {
  id: string
  name: string
  model: string
}
export interface Settings {
  profileId: string
  maxTokens: number
  instructions: string
}
export interface SavedFeed {
  id: string
  createdAt: string
  label: string
  scene: SceneMessage[]
  feed: ThreadverseFeed
}
export interface Store {
  version: 1
  settings: Settings
  chats: Record<string, { name: string; feeds: SavedFeed[] }>
}
export interface Host {
  readChat(): Promise<ChatSnapshot | null>
  listProfiles(): Profile[]
  readStore(): Promise<unknown>
  writeStore(store: Store): Promise<void>
  generate(profileId: string, prompt: string, maxTokens: number, signal: AbortSignal,
    progress: (text: string) => void): Promise<string>
  subscribe(handler: () => void): () => void
}

export interface HostMessage {
  mes?: string
  name?: string
  is_user?: boolean
  is_system?: boolean
}
export interface ConnectionProfile { id: string; name?: string; model?: string; api?: string }
export interface HostContext {
  chat: HostMessage[]
  chatId?: string
  characterId?: number | null
  groupId?: string | null
  characters?: Array<{ avatar?: string; name?: string }>
  groups?: Array<{ id: string; name?: string }>
  chatMetadata?: { integrity?: string }
  extensionSettings: Record<string, unknown> & { disabledExtensions?: string[] }
  saveSettingsDebounced(): void
  CONNECT_API_MAP?: Record<string, { selected?: string }>
  eventSource: { on(event: string, callback: () => void): unknown; removeListener(event: string, callback: () => void): unknown }
  eventTypes: Record<string, string>
  ConnectionManagerRequestService?: {
    getSupportedProfiles(): ConnectionProfile[]
    sendRequest(id: string, messages: Array<{ role: string; content: string }>, maxTokens: number,
      options: { stream: boolean; signal: AbortSignal; extractData: boolean; includePreset: boolean }):
      Promise<{ content?: string } | (() => AsyncGenerator<{ text: string; state?: { reasoning?: string } }>)>
  }
}
export interface TTHost {
  ready?: Promise<void>
  api?: {
    chat?: { current: { handle(): { stableId(): Promise<string> } } }
    extension?: { store?: {
      tryGetJson(args: { namespace: string; key: string }): Promise<{ found: boolean; value?: unknown }>
      setJson(args: { namespace: string; key: string; value: Store }): Promise<void>
    } }
  }
}
declare global {
  interface Window {
    SillyTavern?: { getContext(): HostContext }
    __TAURITAVERN__?: TTHost
    __TAURITAVERN_MAIN_READY__?: Promise<void>
  }
}
