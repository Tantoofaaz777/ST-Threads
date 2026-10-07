import { buildThreadversePrompt } from './core/prompt'
import { parseGeneratedThreadverseFeed } from './core/feed'
import { MAX_FEEDS_PER_CHAT, normalizeSettings, Repository } from './store'
import type { ChatSnapshot, Host, SavedFeed, SceneMessage, Settings, Store } from './types'

export function appendFeed(store: Store, origin: ChatSnapshot, saved: SavedFeed): void {
  const previous = store.chats[origin.key]?.feeds || []
  store.chats[origin.key] = { ...store.chats[origin.key], name: origin.name,
    feeds: [...previous.filter(item => item.id !== saved.id), saved].slice(-MAX_FEEDS_PER_CHAT) }
}
export class SaveFeedError extends Error {
  constructor(public saved: SavedFeed, cause: unknown) {
    super('The feed was generated but could not be saved.', { cause })
  }
}

export function sameMessage(left: SceneMessage, right: SceneMessage): boolean {
  return left.index === right.index && left.role === right.role && left.content === right.content
}
export function scenePrompt(scene: SceneMessage[], label: string, instructions: string): string {
  return buildThreadversePrompt({ previousRanges: [], fandomContinuity: [],
    recentRange: { label: label.trim() || 'Selected scene',
      content: scene.map(item => `[#${item.index + 1} / ${item.name} / ${item.role}]\n${item.content}`).join('\n\n') },
    instructions })
}

export class Generation {
  private active: AbortController | null = null
  private saving = false
  get running(): boolean { return this.active !== null }
  get committing(): boolean { return this.saving }
  constructor(private host: Host, private repository: Repository) {}
  cancel(): void { if (!this.saving) this.active?.abort(new DOMException('Generation canceled.', 'AbortError')) }
  async run(expected: ChatSnapshot, indices: Set<number>, label: string, settings: Settings,
    progress: (text: string) => void, onCommit: () => void = () => {}): Promise<SavedFeed> {
    if (this.active) throw new Error('A generation is already in progress.')
    const selected = expected.messages.filter(item => indices.has(item.index))
    if (!selected.length) throw new Error('Select at least one message.')
    if (!settings.profileId) throw new Error('Choose a generation model or connection profile.')
    const input = normalizeSettings(structuredClone(settings))
    const scene = structuredClone(selected)
    const controller = new AbortController()
    this.active = controller
    try {
      const snapshot = await this.host.readChat()
      controller.signal.throwIfAborted()
      if (!snapshot || snapshot.key !== expected.key || selected.some(item => {
        const current = snapshot.messages.find(message => message.index === item.index)
        return !current || !sameMessage(item, current)
      })) throw new Error('The scene changed. Refresh the list and check your selection before generating.')
      // Own the scene and settings before awaiting the network, even if the UI changes chat.
      const prompt = scenePrompt(scene, label, input.instructions)
      const output = await this.host.generate({ kind: input.generationTargetKind, id: input.profileId }, prompt, input.maxTokens,
        controller.signal, progress)
      controller.signal.throwIfAborted()
      const feed = parseGeneratedThreadverseFeed(output)
      const saved: SavedFeed = { id: crypto.randomUUID(), createdAt: new Date().toISOString(),
        label: label.trim() || 'Selected scene', scene, feed,
        generation: { presetId: input.activeInstructionPresetId,
          presetName: input.instructionPresets.find(preset => preset.id === input.activeInstructionPresetId)!.name,
          instructions: input.instructions } }
      try {
        await this.repository.update(store => {
          controller.signal.throwIfAborted()
          this.saving = true
          onCommit()
          appendFeed(store, snapshot, saved)
        })
      } catch (error) {
        if (controller.signal.aborted) throw error
        throw new SaveFeedError(saved, error)
      }
      return saved
    } catch (error) {
      if (controller.signal.aborted) throw new DOMException('Generation canceled.', 'AbortError')
      throw error
    } finally { this.saving = false; if (this.active === controller) this.active = null }
  }
}
