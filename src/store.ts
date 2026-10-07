import { parseThreadverseFeed } from './core/feed'
import type { Host, SavedFeed, Settings, Store } from './types'

export const DEFAULT_INSTRUCTIONS = `You are simulating an online fandom discussing a fictional story as an ongoing television series or serialized fanfiction.
Discuss the selected scene as an audience. Do not continue or rewrite the story.
Create a Reddit-style discussion with an opening post, varied usernames, nested replies, votes, theories, jokes, shipping, criticism and disagreement.
Write the discussion in English. Create 3 to 5 separate conversations, each with replies.`
const LEGACY_DEFAULT_INSTRUCTIONS = DEFAULT_INSTRUCTIONS.replace('in English.', 'in Brazilian Portuguese.')
export const MAX_FEEDS_PER_CHAT = 10

export function normalizeSettings(value: unknown): Settings {
  const item = (value && typeof value === 'object' ? value : {}) as Partial<Settings>
  return {
    profileId: typeof item.profileId === 'string' ? item.profileId : '',
    maxTokens: typeof item.maxTokens === 'number' && Number.isInteger(item.maxTokens)
      && item.maxTokens >= 256 && item.maxTokens <= 32768 ? item.maxTokens : 4096,
    instructions: typeof item.instructions === 'string' && item.instructions.trim()
      && item.instructions.replace(/\r\n/g, '\n') !== LEGACY_DEFAULT_INSTRUCTIONS
      ? item.instructions : DEFAULT_INSTRUCTIONS,
  }
}

export function normalizeStore(value: unknown): Store {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<Store>
  if (input.version !== undefined && input.version !== 1) {
    throw new Error('The saved data belongs to another version. Back it up before continuing.')
  }
  const result: Store = { version: 1, settings: normalizeSettings(input.settings), chats: Object.create(null) }
  if (input.chats && typeof input.chats === 'object') {
    for (const [key, raw] of Object.entries(input.chats)) {
      if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !Array.isArray(raw.feeds)) continue
      const feeds: SavedFeed[] = []
      for (const item of raw.feeds.slice(-MAX_FEEDS_PER_CHAT)) {
        if (!item || typeof item.id !== 'string' || typeof item.label !== 'string'
          || typeof item.createdAt !== 'string' || !Array.isArray(item.scene)) continue
        try {
          feeds.push({ id: item.id, label: item.label, createdAt: item.createdAt,
            scene: item.scene.filter(message => message && Number.isInteger(message.index)
              && typeof message.content === 'string' && typeof message.name === 'string'
              && (message.role === 'user' || message.role === 'assistant')),
            feed: parseThreadverseFeed(JSON.stringify(item.feed)) })
        } catch { /* Invalid individual feeds do not block other saved threads. */ }
      }
      result.chats[key] = { name: raw.name, feeds }
    }
  }
  return result
}

// One queue covers both settings and generation commits, avoiding lost updates.
export class Repository {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private host: Pick<Host, 'readStore' | 'writeStore'>) {}
  async read(): Promise<Store> {
    await this.queue.catch(() => undefined)
    return normalizeStore(await this.host.readStore())
  }
  update(change: (store: Store) => void): Promise<Store> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      const store = normalizeStore(await this.host.readStore())
      change(store)
      await this.host.writeStore(store)
      return store
    })
    this.queue = operation
    return operation
  }
}
