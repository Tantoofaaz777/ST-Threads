import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { mountUi } from '../src/ui'
import { normalizeStore } from '../src/store'
import { parseGeneratedThreadverseFeed } from '../src/core/feed'
import { context, fixture, modelOutput } from './fixtures'

let browser: Window
let cleanup: (() => void) | undefined
let originalGlobals: Record<string, PropertyDescriptor | undefined>
const globals = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'MouseEvent']

beforeEach(() => {
  browser = new Window({ url: 'http://localhost/' })
  originalGlobals = {}
  for (const name of globals) {
    originalGlobals[name] = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: (browser as any)[name] })
  }
  browser.document.body.innerHTML = '<div id="extensions_settings2"></div>'
  // happy-dom currently does not implement the native dialog methods.
  const prototype = browser.HTMLDialogElement.prototype
  prototype.showModal = function () { this.setAttribute('open', '') }
  prototype.close = function () { this.removeAttribute('open') }
})
afterEach(() => {
  cleanup?.(); cleanup = undefined
  browser.happyDOM.cancelAsync()
  for (const name of globals) {
    const descriptor = originalGlobals[name]
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as any)[name]
  }
})
function button(selector: string) { return document.querySelector<HTMLButtonElement>(selector)! }
function input(selector: string, value: string) {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  field.value = value
  field.dispatchEvent(new browser.Event('input', { bubbles: true }) as any)
}
function choose(selector: string, value: string) {
  const field = document.querySelector<HTMLSelectElement>(selector)!
  field.value = value
  field.dispatchEvent(new browser.Event('change', { bubbles: true }) as any)
}
async function settle(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error('The interface did not complete the operation')
}

test('mounts the launcher, selects messages, generates a feed and cleans up the panel', async () => {
  const f = fixture()
  cleanup = await mountUi(f.host)
  expect(document.querySelectorAll('.sth-launcher')).toHaveLength(1)
  button('.sth-launcher button').click()
  const selected = document.querySelector<HTMLInputElement>('[data-index="0"]')!
  selected.click()
  const profile = document.querySelector<HTMLSelectElement>('[data-profile]')!
  profile.value = 'profile'
  profile.dispatchEvent(new browser.Event('change', { bubbles: true }) as any)
  expect(button('[data-generate]').disabled).toBe(false)
  button('[data-generate]').click()
  await settle(() => document.querySelectorAll('.sth-feed').length > 0)
  expect(document.querySelector('.sth-feed')!.textContent).toContain('Who saw that scene?')
  expect(document.querySelectorAll('.sth-replies')).toHaveLength(3)
  expect(f.writes.at(-1)!.chats['st:origin'].feeds).toHaveLength(1)
  cleanup(); cleanup = undefined
  expect(document.querySelector('.sth-dialog')).toBeNull()
  expect(document.querySelector('.sth-launcher')).toBeNull()
})

test('chat and model HTML is displayed as text without executing markup', async () => {
  const f = fixture()
  const text = '<img src=x onerror="window.hacked=1"><script>bad()</script>'
  f.setChat({ key: 'st:origin', name: '<b>Chat</b>', messages: [{ index: 0, role: 'user', name: text, content: text }] })
  const feed = parseGeneratedThreadverseFeed(modelOutput)
  feed.post.body = text; feed.title = text
  const state = normalizeStore(undefined)
  state.chats['st:origin'] = { name: 'Chat', feeds: [{ id: 'one', createdAt: new Date().toISOString(), label: text,
    scene: [], feed }] }
  f.setStore(state)
  cleanup = await mountUi(f.host)
  expect(document.querySelector('.sth-dialog img, .sth-dialog script')).toBeNull()
  expect(document.querySelector('.sth-feed')!.textContent).toContain(text)
  expect(document.querySelector('[data-chat]')!.textContent).toContain('<b>Chat</b>')
})

test('a save failure keeps the result and allows retrying', async () => {
  const f = fixture()
  const write = f.host.writeStore
  let fails = true
  f.host.writeStore = async state => {
    if (fails && Object.values(state.chats).some(item => item.feeds.length)) throw new Error('Disk error')
    await write(state)
  }
  cleanup = await mountUi(f.host)
  document.querySelector<HTMLInputElement>('[data-index="0"]')!.click()
  const profile = document.querySelector<HTMLSelectElement>('[data-profile]')!
  profile.value = 'profile'
  profile.dispatchEvent(new browser.Event('change') as any)
  button('[data-generate]').click()
  await settle(() => document.querySelector('[data-feeds]')!.textContent!.includes('Retry saving'))
  expect(document.querySelector('.sth-feed')!.textContent).toContain('Who saw that scene?')
  fails = false
  const retry = [...document.querySelectorAll<HTMLButtonElement>('[data-feeds] button')].find(item => item.textContent === 'Retry saving')!
  retry.click()
  await settle(() => document.querySelector('[data-status]')!.textContent === 'Feed saved for the original chat.')
  expect(f.writes.at(-1)!.chats['st:origin'].feeds).toHaveLength(1)
})

test('repeated enable mounts once and disable removes the interface', async () => {
  const ctx = context()
  ;(window as any).SillyTavern = { getContext: () => ctx }
  const entry = await import('../src/index')
  entry.onEnable(); entry.onEnable()
  await settle(() => document.querySelectorAll('.sth-dialog').length === 1)
  entry.onEnable()
  expect(document.querySelectorAll('.sth-launcher')).toHaveLength(1)
  entry.onDisable()
  expect(document.querySelector('.sth-dialog')).toBeNull()
  expect(document.querySelector('.sth-launcher')).toBeNull()
})

test('creates, edits and switches presets, then generates the previewed range and reloads the selection', async () => {
  const f = fixture()
  cleanup = await mountUi(f.host)
  button('[data-new-preset]').click()
  const presetId = document.querySelector<HTMLSelectElement>('[data-preset]')!.value
  input('[data-preset-name]', 'Theory corner')
  input('[data-instructions]', 'Focus on clues and wild theories. Keep the discussion in English.')
  choose('[data-preset]', 'default')
  expect(document.querySelector<HTMLTextAreaElement>('[data-instructions]')!.value).not.toContain('wild theories')
  choose('[data-preset]', presetId)
  expect(document.querySelector<HTMLTextAreaElement>('[data-instructions]')!.value).toContain('wild theories')
  input('[data-from]', '2'); input('[data-to]', '2')
  button('[data-range]').click()
  input('[data-label]', 'The reveal')
  button('[data-preview]').click()
  const preview = document.querySelector('[data-prompt]')!.textContent!
  expect(preview).toContain('He was waiting.')
  expect(preview).not.toContain('She opened the door.')
  expect(preview).toContain('wild theories')
  expect(preview).toContain('# OUTPUT FORMAT')
  let sent = ''
  f.host.generate = async (_profile, prompt) => { sent = prompt; return modelOutput }
  choose('[data-profile]', 'profile')
  button('[data-generate]').click()
  await settle(() => document.querySelectorAll('.sth-feed').length === 1 && !button('[data-save-presets]').disabled)
  expect(sent).toBe(preview)
  expect(f.writes.at(-1)!.chats['st:origin'].instructionPresetId).toBe(presetId)
  expect(document.querySelector('.sth-feed')!.textContent).toContain('Instructions used · Theory corner')
  cleanup(); cleanup = undefined
  cleanup = await mountUi(f.host)
  expect(document.querySelector<HTMLSelectElement>('[data-preset]')!.value).toBe(presetId)
  expect(document.querySelector<HTMLTextAreaElement>('[data-instructions]')!.value).toContain('wild theories')
})

test('duplicates a draft, removes a saved preset, and clears references without changing old feed instructions', async () => {
  const f = fixture()
  cleanup = await mountUi(f.host)
  expect(button('[data-delete-preset]').disabled).toBe(true)
  input('[data-instructions]', 'Unique original prompt.')
  button('[data-duplicate-preset]').click()
  const copyId = document.querySelector<HTMLSelectElement>('[data-preset]')!.value
  expect(document.querySelector<HTMLTextAreaElement>('[data-instructions]')!.value).toBe('Unique original prompt.')
  input('[data-preset-name]', 'Copy')
  button('[data-save-presets]').click()
  await settle(() => f.writes.length === 1 && !button('[data-save-presets]').disabled)
  expect(f.writes[0].settings.instructionPresets).toHaveLength(2)
  const saved = f.writes[0]
  saved.chats.other = { name: 'Other', instructionPresetId: copyId, feeds: [{ id: 'old', createdAt: '2026-10-07', label: 'Old',
    scene: [], feed: parseGeneratedThreadverseFeed(modelOutput),
    generation: { presetId: copyId, presetName: 'Copy', instructions: 'Historical prompt.' } }] }
  f.setStore(saved)
  button('[data-delete-preset]').click()
  button('[data-save-presets]').click()
  await settle(() => f.writes.length === 2 && !button('[data-save-presets]').disabled)
  const state = f.writes.at(-1)!
  expect(state.settings.instructionPresets.map(item => item.id)).toEqual(['default'])
  expect(state.chats.other.instructionPresetId).toBeUndefined()
  expect(state.chats.other.feeds[0].generation!.instructions).toBe('Historical prompt.')
  expect(button('[data-delete-preset]').disabled).toBe(true)
})

test('keeps preset drafts on save failure and blocks duplicate names before sending a model request', async () => {
  const f = fixture()
  cleanup = await mountUi(f.host)
  button('[data-new-preset]').click()
  input('[data-preset-name]', ' default ')
  let called = false
  f.host.generate = async () => { called = true; return modelOutput }
  document.querySelector<HTMLInputElement>('[data-index="0"]')!.click()
  choose('[data-profile]', 'profile')
  button('[data-generate]').click()
  await settle(() => document.querySelector('[data-status]')!.textContent!.includes('already exists'))
  expect(called).toBe(false)
  expect(f.writes).toHaveLength(0)
  input('[data-preset-name]', 'My preset')
  input('[data-instructions]', 'Keep this unsaved draft.')
  const write = f.host.writeStore
  f.host.writeStore = async () => { throw new Error('Disk unavailable') }
  button('[data-save-presets]').click()
  await settle(() => document.querySelector('[data-status]')!.textContent!.includes('Disk unavailable'))
  button('[data-refresh]').click()
  await settle(() => !button('[data-save-presets]').disabled)
  expect(document.querySelector<HTMLTextAreaElement>('[data-instructions]')!.value).toBe('Keep this unsaved draft.')
  expect(document.querySelector('[data-preset-status]')!.textContent).toContain('Unsaved')
  f.host.writeStore = write
  button('[data-save-presets]').click()
  await settle(() => f.writes.length === 1 && !button('[data-save-presets]').disabled)
  expect(f.writes[0].settings.instructions).toBe('Keep this unsaved draft.')
})

test('remembers the preset for each chat while retaining edits during chat switches', async () => {
  const f = fixture()
  const state = normalizeStore({ settings: { instructionPresets: [
    { id: 'a', name: 'Analysis', instructions: 'Analyze.' },
    { id: 'b', name: 'Banter', instructions: 'Make jokes.' },
  ], activeInstructionPresetId: 'b' }, chats: {
    'st:origin': { name: 'Origin', feeds: [], instructionPresetId: 'a' },
    other: { name: 'Other', feeds: [], instructionPresetId: 'b' },
  } })
  f.setStore(state)
  cleanup = await mountUi(f.host)
  expect(document.querySelector<HTMLSelectElement>('[data-preset]')!.value).toBe('a')
  input('[data-instructions]', 'My analysis draft.')
  f.setChat({ key: 'other', name: 'Other', messages: [] })
  button('[data-refresh]').click()
  await settle(() => document.querySelector<HTMLSelectElement>('[data-preset]')!.value === 'b')
  f.setChat({ key: 'st:origin', name: 'Origin', messages: [] })
  button('[data-refresh]').click()
  await settle(() => document.querySelector<HTMLSelectElement>('[data-preset]')!.value === 'a')
  expect(document.querySelector<HTMLTextAreaElement>('[data-instructions]')!.value).toBe('My analysis draft.')
})
