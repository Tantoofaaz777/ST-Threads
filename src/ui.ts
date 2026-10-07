import { serializeFeedAsPlainText } from './core/feed'
import type { ThreadverseComment } from './core/shared'
import { appendFeed, Generation, sameMessage, SaveFeedError } from './generation'
import { normalizeSettings, Repository } from './store'
import type { ChatSnapshot, Host, SavedFeed, Settings } from './types'

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const item = document.createElement(tag)
  item.className = className
  item.textContent = text
  return item
}
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return 'Could not complete the operation.'
  const cause = error.cause instanceof Error ? ` ${error.cause.message}` : ''
  return error.message + cause
}

export async function mountUi(host: Host): Promise<() => void> {
  const repository = new Repository(host)
  let store = await repository.read()
  const generation = new Generation(host, repository)
  let snapshot: ChatSnapshot | null = null
  let selection = new Set<number>()
  let disposed = false
  let revision = 0
  let visibleCount = 100
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let unsaved: SavedFeed | null = null
  let unsavedChat: ChatSnapshot | null = null
  let operationPending = false

  const launcher = element('div', 'sth-launcher')
  const openButton = element('button', 'menu_button', 'Open ST Threads')
  openButton.type = 'button'
  launcher.append(element('strong', '', 'ST Threads'),
    element('p', '', 'See your story through the eyes of a fandom.'), openButton)
  const target = document.querySelector('#extensions_settings2, #extensions_settings')
  if (!target) launcher.classList.add('sth-floating-launcher')
  ;(target || document.body).append(launcher)

  const dialog = element('dialog', 'sth-dialog')
  dialog.setAttribute('aria-labelledby', 'sth-title')
  dialog.innerHTML = `
    <header class="sth-header"><div><h2 id="sth-title">ST Threads</h2><p data-chat>Open a chat to get started.</p></div>
      <button type="button" data-close aria-label="Close panel">✕</button></header>
    <nav class="sth-tabs" aria-label="ST Threads sections">
      <button type="button" data-tab="make" aria-pressed="true">Create feed</button>
      <button type="button" data-tab="feeds" aria-pressed="false">Saved feeds</button>
      <button type="button" data-tab="settings" aria-pressed="false">Settings</button>
    </nav>
    <div class="sth-status" data-status role="status" aria-live="polite"></div>
    <div class="sth-content">
      <section data-panel="make">
        <div class="sth-card"><h3>Select a scene</h3>
          <p>Select the messages the fandom will discuss. The feed stays separate from your roleplay.</p>
          <div class="sth-toolbar"><button type="button" data-refresh>Refresh</button>
            <button type="button" data-clear>Clear selection</button><span data-count>0 selected</span></div>
          <div class="sth-range"><label>From message<input type="number" min="1" step="1" data-from></label>
            <label>To message<input type="number" min="1" step="1" data-to></label>
            <button type="button" data-range>Select range</button></div>
          <label class="sth-field">Search messages<input type="search" data-search placeholder="Scene text or name…"></label>
          <div class="sth-messages" data-messages></div>
          <button type="button" data-more hidden>Show earlier messages</button>
        </div>
        <div class="sth-card">
          <label class="sth-field">Scene title<input type="text" data-label maxlength="200" placeholder="Chapter, episode or scene"></label>
          <label class="sth-field">Generation profile<select data-profile><option value="">Choose a profile…</option></select></label>
          <p class="sth-hint" data-profile-hint></p>
          <div class="sth-toolbar"><button type="button" class="sth-primary" data-generate>Generate feed</button>
            <button type="button" data-cancel hidden>Cancel generation</button></div>
          <details><summary>Model response</summary><pre class="sth-output" data-output></pre></details>
        </div>
      </section>
      <section data-panel="feeds" hidden><p class="sth-hint">The latest 10 feeds are saved for each chat.</p><div data-feeds></div></section>
      <section data-panel="settings" hidden><div class="sth-card">
        <label class="sth-field">Response token limit<input type="number" data-tokens min="256" max="32768" step="1"></label>
        <label class="sth-field">Fandom instructions<textarea data-instructions rows="9"></textarea></label>
        <p class="sth-hint">This first version discusses only the selected scene. Continuity between feeds and regex support will follow in future updates.</p>
        <button type="button" data-save-settings>Save settings</button>
      </div></section>
    </div>`
  document.body.append(dialog)
  function query<T extends HTMLElement>(selector: string): T {
    const result = dialog.querySelector<T>(selector)
    if (!result) throw new Error(`Missing element: ${selector}`)
    return result
  }
  const messages = query<HTMLDivElement>('[data-messages]')
  const profile = query<HTMLSelectElement>('[data-profile]')
  const search = query<HTMLInputElement>('[data-search]')
  const sceneLabel = query<HTMLInputElement>('[data-label]')
  const instructions = query<HTMLTextAreaElement>('[data-instructions]')
  const tokens = query<HTMLInputElement>('[data-tokens]')
  instructions.value = store.settings.instructions
  tokens.value = String(store.settings.maxTokens)

  function status(text: string, error = false): void {
    if (disposed) return
    const node = query('[data-status]')
    node.textContent = text
    node.classList.toggle('sth-error', error)
  }
  function tab(name: string): void {
    for (const section of dialog.querySelectorAll<HTMLElement>('[data-panel]')) section.hidden = section.dataset.panel !== name
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      button.setAttribute('aria-pressed', String(button.dataset.tab === name))
    }
  }
  function settings(): Settings {
    const maxTokens = Number(tokens.value)
    if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 32768) {
      throw new Error('The token limit must be an integer between 256 and 32768.')
    }
    if (!instructions.value.trim()) throw new Error('Enter the fandom instructions.')
    return normalizeSettings({ profileId: profile.value, maxTokens, instructions: instructions.value })
  }
  function controls(): void {
    const busy = operationPending || generation.running
    query<HTMLButtonElement>('[data-generate]').disabled = busy || !snapshot || selection.size === 0 || !profile.value || !!unsaved
    query<HTMLButtonElement>('[data-cancel]').hidden = !generation.running
    query<HTMLButtonElement>('[data-cancel]').disabled = generation.committing
    query<HTMLButtonElement>('[data-save-settings]').disabled = busy
    profile.disabled = busy
    query('[data-count]').textContent = `${selection.size} selected`
  }
  function profiles(): void {
    const previous = profile.value || store.settings.profileId
    const option = (text: string, value: string) => {
      const node = element('option', '', text)
      node.value = value
      return node
    }
    profile.replaceChildren(option('Choose a profile…', ''))
    try {
      const available = host.listProfiles()
      for (const item of available) profile.append(option(`${item.name}${item.model ? ` · ${item.model}` : ''}`, item.id))
      profile.value = available.some(item => item.id === previous) ? previous : ''
      query('[data-profile-hint]').textContent = available.length
        ? 'Uses the selected profile without changing your roleplay connection.'
        : 'Create a Chat Completion profile in Connection Manager, then refresh this panel.'
    } catch (error) { query('[data-profile-hint]').textContent = errorText(error) }
    controls()
  }
  function renderMessages(): void {
    const queryText = search.value.trim().toLocaleLowerCase()
    const matching = (snapshot?.messages || []).filter(item => !queryText
      || `${item.name}\n${item.content}`.toLocaleLowerCase().includes(queryText))
    const displayed = matching.slice(-visibleCount)
    const fragment = document.createDocumentFragment()
    if (!displayed.length) fragment.append(element('p', 'sth-empty', snapshot
      ? 'No messages found.' : 'Open a character or group chat.'))
    for (const item of displayed) {
      const row = element('label', 'sth-message')
      const checkbox = element('input')
      checkbox.type = 'checkbox'
      checkbox.checked = selection.has(item.index)
      checkbox.dataset.index = String(item.index)
      const body = element('div')
      body.append(element('strong', '', `#${item.index + 1} · ${item.name}`),
        element('p', '', item.content))
      row.append(checkbox, body)
      fragment.append(row)
    }
    messages.replaceChildren(fragment)
    query<HTMLButtonElement>('[data-more]').hidden = displayed.length === matching.length
    controls()
  }
  function renderComment(comment: ThreadverseComment): HTMLElement {
    const node = element('article', 'sth-comment')
    node.append(element('strong', 'sth-author', `u/${comment.username} · ${comment.score} votes`),
      element('p', 'sth-body', comment.body))
    if (comment.replies.length) {
      const children = element('div', 'sth-replies')
      for (const reply of comment.replies) children.append(renderComment(reply))
      node.append(children)
    }
    return node
  }
  function feedCard(item: SavedFeed): HTMLElement {
    const card = element('article', 'sth-card sth-feed')
    card.append(element('p', 'sth-hint', `${item.label} · ${new Date(item.createdAt).toLocaleString('en-US')}`),
      element('h3', '', item.feed.title),
      element('strong', 'sth-author', `u/${item.feed.post.username} · ${item.feed.post.score} votes`),
      element('p', 'sth-body', item.feed.post.body))
    const copy = element('button', '', 'Copy feed')
    copy.type = 'button'
    copy.addEventListener('click', () => {
      if (!navigator.clipboard?.writeText) {
        status('Select the feed text to copy it manually.', true); return
      }
      void navigator.clipboard.writeText(serializeFeedAsPlainText(item.feed))
        .then(() => status('Feed copied.')).catch(() => status('Could not copy the feed. Select the feed text to copy it manually.', true))
    })
    card.append(copy)
    const scene = element('details', 'sth-scene')
    scene.append(element('summary', '', `Original scene · ${item.scene.length} messages`))
    for (const message of item.scene) scene.append(element('p', 'sth-body', `#${message.index + 1} · ${message.name}\n${message.content}`))
    card.append(scene)
    for (const comment of item.feed.comments) card.append(renderComment(comment))
    return card
  }
  function renderFeeds(): void {
    const list = query('[data-feeds]')
    list.replaceChildren()
    if (unsaved) {
      const recovery = element('div', 'sth-card')
      recovery.append(element('strong', '', 'Feed generated but not saved'),
        element('p', '', `Original chat: ${unsavedChat?.name || ''}. The result has been kept in this panel.`))
      const retry = element('button', '', 'Retry saving')
      retry.type = 'button'
      retry.disabled = operationPending
      retry.addEventListener('click', () => { void saveRecovery() })
      recovery.append(retry)
      list.append(recovery, feedCard(unsaved))
    }
    const feeds = snapshot ? store.chats[snapshot.key]?.feeds || [] : []
    if (!feeds.length) list.append(element('p', 'sth-empty', 'Feeds for this chat will appear here.'))
    for (const feed of [...feeds].reverse()) list.append(feedCard(feed))
  }
  async function refresh(): Promise<void> {
    const request = ++revision
    try {
      const [next, nextStore] = await Promise.all([host.readChat(), repository.read()])
      if (disposed || request !== revision) return
      if (next?.key !== snapshot?.key) { selection.clear(); sceneLabel.value = ''; visibleCount = 100 }
      else if (next && snapshot) {
        selection = new Set([...selection].filter(index => {
          const before = snapshot!.messages.find(item => item.index === index)
          const after = next.messages.find(item => item.index === index)
          return before && after && sameMessage(before, after)
        }))
      }
      snapshot = next
      store = nextStore
      query('[data-chat]').textContent = next?.name || 'Open a chat to get started.'
      profiles()
      renderMessages()
      renderFeeds()
    } catch (error) {
      if (!disposed && request === revision) {
        snapshot = null; selection.clear(); renderMessages(); renderFeeds()
        status(errorText(error), true)
      }
    }
  }
  async function saveSettings(): Promise<void> {
    if (operationPending || generation.running) return
    try {
      const input = settings()
      operationPending = true; controls()
      store = await repository.update(data => { data.settings = input })
      status('Settings saved.')
    } catch (error) { status(errorText(error), true) }
    finally { operationPending = false; if (!disposed) controls() }
  }
  async function generate(): Promise<void> {
    if (!snapshot || operationPending || generation.running || unsaved) return
    const origin = structuredClone(snapshot)
    const indices = new Set(selection)
    const label = sceneLabel.value
    try {
      const input = settings()
      operationPending = true; controls()
      store = await repository.update(data => { data.settings = input })
      if (disposed) return
      query('[data-output]').textContent = ''
      status('Generating discussion…')
      const result = generation.run(origin, indices, label, input, text => {
        if (disposed) return
        query('[data-output]').textContent = text
        status(`Generating discussion… ${text.length.toLocaleString('en-US')} characters received.`)
      }, () => { status('Saving feed…'); controls() })
      controls()
      await result
      if (disposed) return
      await refresh()
      status(snapshot?.key === origin.key ? 'Feed generated and saved for this chat.' : `Feed saved for the original chat: ${origin.name}.`)
      tab('feeds')
    } catch (error) {
      if (disposed) return
      if (error instanceof SaveFeedError) {
        unsaved = error.saved; unsavedChat = origin
        renderFeeds(); tab('feeds')
        status('The feed was generated, but saving failed. Retry saving or copy the result.', true)
      } else status(error instanceof DOMException && error.name === 'AbortError'
        ? 'Generation canceled. No feed was saved.' : errorText(error), !(error instanceof DOMException && error.name === 'AbortError'))
    } finally { operationPending = false; if (!disposed) { controls(); if (unsaved) renderFeeds() } }
  }
  async function saveRecovery(): Promise<void> {
    if (!unsaved || !unsavedChat || operationPending) return
    operationPending = true; controls(); renderFeeds()
    try {
      const result = unsaved
      const origin = unsavedChat
      store = await repository.update(data => appendFeed(data, origin, result))
      unsaved = null; unsavedChat = null
      status('Feed saved for the original chat.')
    } catch (error) { status(errorText(error), true) }
    finally { operationPending = false; if (!disposed) { controls(); renderFeeds() } }
  }
  function click(event: MouseEvent): void {
    const button = (event.target as Element).closest<HTMLButtonElement>('button')
    if (!button) return
    if (button.dataset.tab) tab(button.dataset.tab)
    else if (button.hasAttribute('data-close')) dialog.close()
    else if (button.hasAttribute('data-refresh')) { void refresh() }
    else if (button.hasAttribute('data-clear')) { selection.clear(); renderMessages() }
    else if (button.hasAttribute('data-more')) { visibleCount += 100; renderMessages() }
    else if (button.hasAttribute('data-save-settings')) { void saveSettings() }
    else if (button.hasAttribute('data-generate')) { void generate() }
    else if (button.hasAttribute('data-cancel')) { generation.cancel(); status('Canceling generation…') }
    else if (button.hasAttribute('data-range')) {
      const from = Number(query<HTMLInputElement>('[data-from]').value)
      const to = Number(query<HTMLInputElement>('[data-to]').value)
      if (!snapshot || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from
        || to > (snapshot.messages.at(-1)?.index ?? -1) + 1) {
        status('Enter a valid message range.', true); return
      }
      selection = new Set(snapshot.messages.filter(item => item.index + 1 >= from && item.index + 1 <= to).map(item => item.index))
      renderMessages()
    }
  }
  function changed(event: Event): void {
    const input = event.target as HTMLInputElement
    if (input.matches('[data-index]')) {
      const index = Number(input.dataset.index)
      if (input.checked) selection.add(index); else selection.delete(index)
      controls()
    }
  }
  function open(): void {
    if (!dialog.open) dialog.showModal()
    void refresh()
  }
  const unsubscribe = host.subscribe(() => {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => { void refresh() }, 120)
  })
  openButton.addEventListener('click', open)
  dialog.addEventListener('click', click)
  dialog.addEventListener('change', changed)
  search.addEventListener('input', () => { visibleCount = 100; renderMessages() })
  profile.addEventListener('change', controls)
  await refresh()
  return () => {
    disposed = true; ++revision
    clearTimeout(refreshTimer)
    generation.cancel(); unsubscribe()
    openButton.removeEventListener('click', open)
    dialog.close(); dialog.remove(); launcher.remove()
  }
}
