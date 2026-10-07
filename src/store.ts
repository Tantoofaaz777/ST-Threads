import { parseThreadverseFeed } from './core/feed'
import type { Host, InstructionPreset, SavedFeed, Settings, Store } from './types'

export const DEFAULT_INSTRUCTIONS = `You are simulating an online fandom discussing a fictional story as an ongoing television series or serialized fanfiction.
Discuss the selected scene as an audience. Do not continue or rewrite the story.
Create a Reddit-style discussion with an opening post, varied usernames, nested replies, votes, theories, jokes, shipping, criticism and disagreement.
Write the discussion in English. Create 3 to 5 separate conversations, each with replies.`
const LEGACY_DEFAULT_INSTRUCTIONS = DEFAULT_INSTRUCTIONS.replace('in English.', 'in Brazilian Portuguese.')
export const MAX_FEEDS_PER_CHAT = 10
export const MAX_INSTRUCTION_PRESETS = 50

function migrateInstructions(text: string): string {
  return text.replace(/\r\n/g, '\n') === LEGACY_DEFAULT_INSTRUCTIONS ? DEFAULT_INSTRUCTIONS : text
}

export function normalizeSettings(value: unknown): Settings {
  const item = (value && typeof value === 'object' ? value : {}) as Partial<Settings>
  const presets: InstructionPreset[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  if (Array.isArray(item.instructionPresets)) {
    for (const preset of item.instructionPresets) {
      if (!preset || typeof preset.id !== 'string' || !preset.id.trim() || ids.has(preset.id)
        || typeof preset.name !== 'string' || !preset.name.trim() || preset.name.trim().length > 100
        || names.has(preset.name.trim().toLowerCase())
        || typeof preset.instructions !== 'string' || !preset.instructions.trim()) continue
      presets.push({ id: preset.id, name: preset.name.trim(), instructions: migrateInstructions(preset.instructions) })
      ids.add(preset.id); names.add(preset.name.trim().toLowerCase())
    }
  }
  // Preserve the old single prompt as the first preset when upgrading existing installations.
  if (!presets.length) presets.push({ id: 'default', name: 'Default',
    instructions: typeof item.instructions === 'string' && item.instructions.trim()
      ? migrateInstructions(item.instructions) : DEFAULT_INSTRUCTIONS })
  const active = presets.find(preset => preset.id === item.activeInstructionPresetId) || presets[0]
  return {
    profileId: typeof item.profileId === 'string' ? item.profileId : '',
    generationTargetKind: item.generationTargetKind === 'model' ? 'model' : 'profile',
    maxTokens: typeof item.maxTokens === 'number' && Number.isInteger(item.maxTokens)
      && item.maxTokens >= 256 && item.maxTokens <= 32768 ? item.maxTokens : 4096,
    instructionPresets: presets,
    activeInstructionPresetId: active.id,
    instructions: active.instructions,
  }
}

export function validateSettings(input: Settings): Settings {
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < 256 || input.maxTokens > 32768) {
    throw new Error('The token limit must be an integer between 256 and 32768.')
  }
  if (!input.instructionPresets.length || input.instructionPresets.length > MAX_INSTRUCTION_PRESETS) {
    throw new Error(`Keep between 1 and ${MAX_INSTRUCTION_PRESETS} instruction presets.`)
  }
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const preset of input.instructionPresets) {
    if (!preset.id.trim() || ids.has(preset.id)) throw new Error('Instruction preset IDs must be unique.')
    const name = preset.name.trim()
    if (!name || name.length > 100) throw new Error('Preset names must contain 1 to 100 characters.')
    if (names.has(name.toLowerCase())) throw new Error(`A preset named "${name}" already exists.`)
    if (!preset.instructions.trim()) throw new Error(`Enter the instructions for preset "${name}".`)
    ids.add(preset.id); names.add(name.toLowerCase())
  }
  if (!ids.has(input.activeInstructionPresetId)) throw new Error('Choose an instruction preset.')
  return normalizeSettings(input)
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
            feed: parseThreadverseFeed(JSON.stringify(item.feed)),
            ...(item.generation && typeof item.generation.presetId === 'string'
              && typeof item.generation.presetName === 'string' && typeof item.generation.instructions === 'string'
              ? { generation: { presetId: item.generation.presetId, presetName: item.generation.presetName,
                instructions: item.generation.instructions } } : {}) })
        } catch { /* Invalid individual feeds do not block other saved threads. */ }
      }
      result.chats[key] = { name: raw.name, feeds,
        ...(result.settings.instructionPresets.some(preset => preset.id === raw.instructionPresetId)
          ? { instructionPresetId: raw.instructionPresetId } : {}) }
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
