import { describe, expect, test } from 'bun:test'
import { createHost } from '../src/host'
import { Generation, SaveFeedError } from '../src/generation'
import { DEFAULT_INSTRUCTIONS, normalizeSettings, normalizeStore, Repository, validateSettings } from '../src/store'
import { parseGeneratedThreadverseFeed } from '../src/core/feed'
import { chat, context, fixture, modelOutput } from './fixtures'

const settings = { profileId: 'profile', maxTokens: 4096, instructions: 'Discuss the scene.' }

describe('independent generation', () => {
  test('keeps the original scene after switching chats and changing selection', async () => {
    const f = fixture()
    const selection = new Set([0, 1])
    f.host.generate = async (_id, prompt, _tokens, signal) => {
      expect(prompt).toContain('She opened the door.')
      f.setChat({ key: 'other', name: 'Another chat', messages: [] })
      selection.clear()
      signal.throwIfAborted()
      return modelOutput
    }
    const run = new Generation(f.host, new Repository(f.host))
    const saved = await run.run(chat, selection, 'Chapter 1', settings, () => {})
    expect(saved.scene).toEqual(chat.messages)
    expect(f.writes.at(-1)!.chats[chat.key].feeds).toHaveLength(1)
    expect(f.writes.at(-1)!.chats.other).toBeUndefined()
  })
  test('does not send a request if the scene changed before generation', async () => {
    const f = fixture()
    f.setChat({ ...chat, messages: [{ ...chat.messages[0], content: 'Edited text' }] })
    let sent = false
    f.host.generate = async () => { sent = true; return modelOutput }
    const run = new Generation(f.host, new Repository(f.host))
    await expect(run.run(chat, new Set([0]), '', settings, () => {})).rejects.toThrow('The scene changed')
    expect(sent).toBe(false)
    expect(f.writes).toHaveLength(0)
  })
  test('canceling a late response does not save a feed', async () => {
    const f = fixture()
    let began!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    f.host.generate = async () => { began(); await wait; return modelOutput }
    const run = new Generation(f.host, new Repository(f.host))
    const request = run.run(chat, new Set([0]), '', settings, () => {})
    await started
    run.cancel(); release()
    await expect(request).rejects.toHaveProperty('name', 'AbortError')
    expect(f.writes).toHaveLength(0)
    expect(run.running).toBe(false)
  })
  test('does not start two simultaneous generations', async () => {
    const f = fixture()
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    f.host.generate = async () => { await wait; return modelOutput }
    const run = new Generation(f.host, new Repository(f.host))
    const first = run.run(chat, new Set([0]), '', settings, () => {})
    await expect(run.run(chat, new Set([0]), '', settings, () => {})).rejects.toThrow('in progress')
    release(); await first
  })
  test('invalid output is not saved as a successful feed', async () => {
    const f = fixture()
    f.host.generate = async () => 'This is not JSON'
    await expect(new Generation(f.host, new Repository(f.host)).run(chat, new Set([0]), '', settings, () => {})).rejects.toThrow()
    expect(f.writes).toHaveLength(0)
  })
  test('a write failure keeps the feed for recovery', async () => {
    const f = fixture()
    f.host.writeStore = async () => { throw new Error('Disk unavailable') }
    try {
      await new Generation(f.host, new Repository(f.host)).run(chat, new Set([0]), '', settings, () => {})
      throw new Error('Expected a failure')
    } catch (error) {
      expect(error).toBeInstanceOf(SaveFeedError)
      expect((error as SaveFeedError).saved.feed.title).toBe('Who saw that scene?')
    }
  })
  test('canceling after the write starts does not report a false cancellation', async () => {
    const f = fixture()
    const run = new Generation(f.host, new Repository(f.host))
    const saved = await run.run(chat, new Set([0]), '', settings, () => {}, () => run.cancel())
    expect(saved.feed.title).toBe('Who saw that scene?')
    expect(f.writes).toHaveLength(1)
  })
})

describe('persistence and parsing', () => {
  test('migrates the existing single prompt without losing feeds or preferences', () => {
    const oldFeed = { id: 'old', createdAt: '2026-10-07', label: 'Scene', scene: chat.messages,
      feed: parseGeneratedThreadverseFeed(modelOutput) }
    const state = normalizeStore({ version: 1, settings: { ...settings, instructions: 'Keep my custom prompt verbatim.\nSecond line.' },
      chats: { [chat.key]: { name: chat.name, feeds: [oldFeed] } } })
    expect(state.settings.instructionPresets).toEqual([{ id: 'default', name: 'Default',
      instructions: 'Keep my custom prompt verbatim.\nSecond line.' }])
    expect(state.settings.profileId).toBe('profile')
    expect(state.chats[chat.key].feeds).toEqual([oldFeed])
  })
  test('uses the active preset instead of stale single-prompt settings and rejects invalid drafts', () => {
    const state = normalizeSettings({ ...settings, instructionPresets: [
      { id: 'a', name: 'Analysis', instructions: 'Analyze clues.' },
      { id: 'b', name: 'Reactions', instructions: 'React with jokes.' },
    ], activeInstructionPresetId: 'b' })
    expect(state.instructions).toBe('React with jokes.')
    expect(normalizeSettings({ ...state, activeInstructionPresetId: 'removed' }).activeInstructionPresetId).toBe('a')
    expect(() => validateSettings({ ...state, instructionPresets: state.instructionPresets.map(item => ({ ...item, name: 'Same' })) })).toThrow('already exists')
    expect(() => validateSettings({ ...state, instructionPresets: [{ ...state.instructionPresets[0], instructions: ' ' }] })).toThrow('instructions')
  })
  test('snapshots instructions before awaiting the host and preserves the chat preset while saving', async () => {
    const f = fixture()
    const input = normalizeSettings({ ...settings, instructionPresets: [
      { id: 'theories', name: 'Theories', instructions: 'Look for clues and discuss theories.' },
    ], activeInstructionPresetId: 'theories' })
    const store = normalizeStore({ version: 1, settings: input,
      chats: { [chat.key]: { name: chat.name, feeds: [], instructionPresetId: 'theories' } } })
    f.setStore(store)
    const readChat = f.host.readChat
    f.host.readChat = async () => {
      input.instructionPresets[0].instructions = 'Changed while waiting.'
      input.instructions = 'Changed while waiting.'
      return readChat()
    }
    f.host.generate = async (_id, prompt) => {
      expect(prompt).toContain('Look for clues and discuss theories.')
      expect(prompt).not.toContain('Changed while waiting.')
      expect(prompt).toContain('She opened the door.')
      expect(prompt).not.toContain('He was waiting.')
      return modelOutput
    }
    const saved = await new Generation(f.host, new Repository(f.host)).run(chat, new Set([0]), 'Clue', input, () => {})
    expect(saved.generation).toEqual({ presetId: 'theories', presetName: 'Theories', instructions: 'Look for clues and discuss theories.' })
    const reloaded = normalizeStore(f.writes.at(-1))
    expect(reloaded.chats[chat.key].instructionPresetId).toBe('theories')
    expect(reloaded.chats[chat.key].feeds[0].generation).toEqual(saved.generation)
  })
  test('updates the previous built-in language default and preserves custom instructions', () => {
    const oldDefault = DEFAULT_INSTRUCTIONS.replace('in English.', 'in Brazilian Portuguese.')
    expect(normalizeSettings({ instructions: oldDefault }).instructions).toBe(DEFAULT_INSTRUCTIONS)
    expect(normalizeSettings({ instructions: 'Use my custom instructions.' }).instructions).toBe('Use my custom instructions.')
  })
  test('the queue keeps settings and feeds during concurrent writes', async () => {
    const f = fixture()
    const repo = new Repository(f.host)
    const one = repo.update(store => { store.settings.profileId = 'chosen' })
    const two = repo.update(store => { store.chats.origin = { name: 'Origin', feeds: [] } })
    await Promise.all([one, two])
    const state = await repo.read()
    expect(state.settings.profileId).toBe('chosen')
    expect(state.chats.origin).toBeDefined()
  })
  test('a queue failure does not block later writes', async () => {
    const f = fixture()
    const original = f.host.writeStore
    let first = true
    f.host.writeStore = async value => { if (first) { first = false; throw new Error('Failure') }; await original(value) }
    const repo = new Repository(f.host)
    await expect(repo.update(() => {})).rejects.toThrow('Failure')
    await repo.update(store => { store.settings.profileId = 'ok' })
    expect((await repo.read()).settings.profileId).toBe('ok')
  })
  test('the 11th feed only removes the oldest feed from the same chat', async () => {
    const f = fixture()
    const run = new Generation(f.host, new Repository(f.host))
    for (let i = 1; i <= 11; i++) await run.run(chat, new Set([0]), `Scene ${i}`, settings, () => {})
    const feeds = f.writes.at(-1)!.chats[chat.key].feeds
    expect(feeds).toHaveLength(10)
    expect(feeds[0].label).toBe('Scene 2')
    expect(feeds.at(-1)!.label).toBe('Scene 11')
  })
  test('keeps unknown versions without overwriting data', () => {
    expect(() => normalizeStore({ version: 2 })).toThrow('another version')
  })
  test('parsing preserves separate conversations and replies', () => {
    const parsed = parseGeneratedThreadverseFeed('```json\n' + modelOutput + '\n```')
    expect(parsed.comments).toHaveLength(3)
    expect(parsed.comments.every(item => item.replies.length === 1)).toBe(true)
  })
})

describe('ST/TT host adapter', () => {
  test('cumulative streaming does not duplicate text or change the chat or connection', async () => {
    const ctx = context()
    const before = structuredClone(ctx.chat)
    const host = createHost(() => ctx)
    const progress: string[] = []
    expect(await host.generate({ kind: 'profile', id: 'chat-profile' }, 'Prompt', 1000, new AbortController().signal, text => progress.push(text))).toBe('Hello world')
    expect(progress).toEqual(['Hello', 'Hello world'])
    expect(ctx.chat).toEqual(before)
    expect(ctx.extensionSettings.connectionManager).toBeUndefined()
    expect(host.listGenerationTargets().map(item => item.id)).toEqual(['chat-profile'])
  })
  test('excludes system and hidden messages without renumbering absolute indices', async () => {
    const ctx = context()
    const host = createHost(() => ctx)
    const result = await host.readChat()
    expect(result!.messages).toEqual([{ index: 1, role: 'user', name: 'You', content: 'Scene' }])
    ctx.chatId = 'renamed'
    expect((await host.readChat())!.key).toBe(result!.key)
  })
  test('matching chat names for different characters do not mix ST data', async () => {
    const ctx = context()
    const host = createHost(() => ctx)
    const first = await host.readChat()
    ctx.characters![0].avatar = 'other.png'
    expect((await host.readChat())!.key).not.toBe(first!.key)
  })
  test('detects a chat switch while obtaining the TT identity', async () => {
    const ctx = context()
    const host = createHost(() => ctx, { api: { chat: { current: { handle() { return {
      async stableId() { ctx.chatId = 'changed'; ctx.chatMetadata = { integrity: 'other' }; return 'uuid' },
    } } } } } })
    await expect(host.readChat()).rejects.toThrow('chat changed')
  })
  test('a TT Store failure does not silently switch to ST settings', async () => {
    const ctx = context()
    const host = createHost(() => ctx, { api: { extension: { store: {
      async tryGetJson() { throw new Error('I/O') }, async setJson() { throw new Error('I/O') },
    } } } })
    await expect(host.readStore()).rejects.toThrow('I/O')
    expect(ctx.extensionSettings.st_threads).toBeUndefined()
  })
  test('ST settings roundtrip without saving metadata or messages', async () => {
    const ctx = context()
    let scheduled = 0
    ctx.saveSettingsDebounced = () => { scheduled++ }
    const host = createHost(() => ctx)
    const state = normalizeStore(undefined)
    await host.writeStore(state)
    expect(await host.readStore()).toEqual(state)
    expect(scheduled).toBe(1)
    expect(ctx.chatMetadata).toEqual({ integrity: 'chat-uuid' })
  })
  test('removes the same business events it subscribes to', () => {
    const ctx = context()
    const subscribed: string[] = []
    const removed: string[] = []
    ctx.eventSource.on = name => subscribed.push(name)
    ctx.eventSource.removeListener = name => removed.push(name)
    createHost(() => ctx).subscribe(() => {})()
    expect(subscribed).toEqual(['chat_id_changed', 'message_received'])
    expect(removed).toEqual(subscribed)
  })
})
