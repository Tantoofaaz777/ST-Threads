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
