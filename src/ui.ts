import { serializeFeedAsPlainText } from './core/feed'
import type { ThreadverseComment } from './core/shared'
import { appendFeed, Generation, sameMessage, SaveFeedError, scenePrompt } from './generation'
import { DEFAULT_INSTRUCTIONS, MAX_INSTRUCTION_PRESETS, Repository, validateSettings } from './store'
import type { ChatSnapshot, GenerationTarget, Host, SavedFeed, Settings } from './types'

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
  let presetDraft = structuredClone(store.settings.instructionPresets)
  let activePresetId = store.settings.activeInstructionPresetId
  let presetsDirty = false
  const chatPresetSelections = new Map<string, string>()
  let availableTargets: GenerationTarget[] = []
  const targetValue = (target: { kind: string; id: string }) => JSON.stringify([target.kind, target.id])

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
          <label class="sth-field">Instruction preset<select data-preset></select></label>
          <div class="sth-toolbar"><button type="button" data-new-preset>New preset</button>
            <button type="button" data-duplicate-preset>Duplicate</button>
            <button type="button" data-delete-preset>Delete preset</button></div>
          <details data-preset-editor open><summary>Edit instruction preset</summary>
            <label class="sth-field">Preset name<input type="text" data-preset-name maxlength="100"></label>
            <label class="sth-field">Fandom instructions<textarea data-instructions rows="9"></textarea></label>
          </details>
          <p class="sth-hint">These instructions are sent with the selected messages. The feed JSON format is added automatically.</p>
          <div class="sth-toolbar"><button type="button" data-save-presets>Save presets</button><span class="sth-hint" data-preset-status></span></div>
          <label class="sth-field">Generation model<select data-profile><option value="">Choose a model or profile…</option></select></label>
          <p class="sth-hint" data-profile-hint></p>
          <div class="sth-toolbar"><button type="button" class="sth-primary" data-generate>Generate feed</button>
            <button type="button" data-cancel hidden>Cancel generation</button>
            <button type="button" data-preview>Preview prompt</button></div>
          <details data-prompt-preview hidden><summary>Prompt sent to the model</summary><pre class="sth-output" data-prompt></pre></details>
          <details><summary>Model response</summary><pre class="sth-output" data-output></pre></details>
        </div>
      </section>
      <section data-panel="feeds" hidden><p class="sth-hint">The latest 10 feeds are saved for each chat.</p><div data-feeds></div></section>
      <section data-panel="settings" hidden><div class="sth-card">
        <label class="sth-field">Response token limit<input type="number" data-tokens min="256" max="32768" step="1"></label>
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
  const presetSelect = query<HTMLSelectElement>('[data-preset]')
  const presetName = query<HTMLInputElement>('[data-preset-name]')
  const tokens = query<HTMLInputElement>('[data-tokens]')
  instructions.value = store.settings.instructions
  tokens.value = String(store.settings.maxTokens)

  function capturePreset(): void {
    const draft = presetDraft.find(item => item.id === activePresetId)!
    if (draft.name !== presetName.value || draft.instructions !== instructions.value) {
      draft.name = presetName.value; draft.instructions = instructions.value; presetsDirty = true
    }
  }
  function renderPresets(): void {
    if (!presetDraft.some(item => item.id === activePresetId)) activePresetId = presetDraft[0].id
    presetSelect.replaceChildren()
    for (const item of presetDraft) {
      const option = element('option', '', item.name.trim() || 'Unnamed preset')
      option.value = item.id; presetSelect.append(option)
    }
    presetSelect.value = activePresetId
    const active = presetDraft.find(item => item.id === activePresetId)!
    presetName.value = active.name; instructions.value = active.instructions
    controls(); updatePreview()
  }
  function selectPreset(id: string): void {
    if (!presetDraft.some(item => item.id === id)) return
    capturePreset()
    activePresetId = id
    presetsDirty = true
    if (snapshot) chatPresetSelections.set(snapshot.key, id)
    renderPresets()
  }
  function editPreset(action: 'new' | 'duplicate' | 'delete'): void {
    if (operationPending || generation.running) return
    capturePreset()
    if (action === 'delete') {
      if (presetDraft.length <= 1) return
      presetDraft = presetDraft.filter(item => item.id !== activePresetId)
      for (const [key, id] of chatPresetSelections) if (id === activePresetId) chatPresetSelections.delete(key)
      activePresetId = presetDraft[0].id
    } else {
      if (presetDraft.length >= MAX_INSTRUCTION_PRESETS) {
        status(`Instruction presets are limited to ${MAX_INSTRUCTION_PRESETS}.`, true); return
      }
      const base = action === 'new' ? 'New preset' : `${presetName.value.trim() || 'Preset'} copy`.slice(0, 90)
      let name = base
      for (let suffix = 2; presetDraft.some(item => item.name.trim().toLowerCase() === name.toLowerCase()); suffix++) name = `${base} ${suffix}`
      activePresetId = crypto.randomUUID()
      presetDraft.push({ id: activePresetId, name, instructions: action === 'new' ? DEFAULT_INSTRUCTIONS : instructions.value })
    }
    presetsDirty = true
    if (snapshot) chatPresetSelections.set(snapshot.key, activePresetId)
    renderPresets()
    query<HTMLDetailsElement>('[data-preset-editor]').open = true
    if (action !== 'delete') { presetName.focus(); presetName.select() }
    status('Preset changes are kept in the panel. Save presets or generate a feed to save them.')
  }
  function updatePreview(show = false): void {
    const preview = query<HTMLDetailsElement>('[data-prompt-preview]')
    if (show) { preview.hidden = false; preview.open = true }
    if (preview.hidden) return
    const scene = (snapshot?.messages || []).filter(item => selection.has(item.index))
    query('[data-prompt]').textContent = scene.length
      ? scenePrompt(scene, sceneLabel.value, instructions.value) : 'Select at least one message to preview the prompt.'
  }

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
    capturePreset()
    const target = availableTargets.find(item => targetValue(item) === profile.value)
    return validateSettings({ profileId: target?.id || '', generationTargetKind: target?.kind || 'profile',
      maxTokens: Number(tokens.value), instructions: instructions.value,
      instructionPresets: structuredClone(presetDraft), activeInstructionPresetId: activePresetId })
  }
  function controls(): void {
    const busy = operationPending || generation.running
    query<HTMLButtonElement>('[data-generate]').disabled = busy || !snapshot || selection.size === 0 || !profile.value || !!unsaved
    query<HTMLButtonElement>('[data-cancel]').hidden = !generation.running
    query<HTMLButtonElement>('[data-cancel]').disabled = generation.committing
    query<HTMLButtonElement>('[data-save-settings]').disabled = busy
    for (const input of dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>(
      '[data-preset], [data-preset-name], [data-instructions], [data-tokens], [data-save-presets], [data-new-preset], [data-duplicate-preset], [data-delete-preset]')) input.disabled = busy
    query<HTMLButtonElement>('[data-delete-preset]').disabled = busy || presetDraft.length <= 1
    query<HTMLButtonElement>('[data-new-preset]').disabled = busy || presetDraft.length >= MAX_INSTRUCTION_PRESETS
    query<HTMLButtonElement>('[data-duplicate-preset]').disabled = busy || presetDraft.length >= MAX_INSTRUCTION_PRESETS
    query('[data-preset-status]').textContent = presetsDirty ? 'Unsaved preset changes' : 'Save or generate to remember this chat\'s selection.'
    profile.disabled = busy
    query('[data-count]').textContent = `${selection.size} selected`
    updatePreview()
  }
  function profiles(): void {
    const previous = profile.value || targetValue({ kind: store.settings.generationTargetKind, id: store.settings.profileId })
    const option = (text: string, value: string) => {
      const node = element('option', '', text)
      node.value = value
      return node
    }
    profile.replaceChildren(option('Choose a model or profile…', ''))
    availableTargets = []
    try {
      availableTargets = host.listGenerationTargets()
      for (const kind of ['model', 'profile'] as const) {
        const targets = availableTargets.filter(item => item.kind === kind)
        if (!targets.length) continue
        const group = element('optgroup')
        group.label = kind === 'model' ? 'Saved models' : 'Connection profiles'
        for (const item of targets) group.append(option(`${item.name}${item.model ? ` · ${item.model}` : ''}`, targetValue(item)))
        profile.append(group)
      }
      profile.value = availableTargets.some(item => targetValue(item) === previous) ? previous : ''
      targetHint()
    } catch (error) { query('[data-profile-hint]').textContent = errorText(error) }
    controls()
  }
  function targetHint(): void {
    const target = availableTargets.find(item => targetValue(item) === profile.value)
    query('[data-profile-hint]').textContent = target?.kind === 'model'
      ? 'Uses the saved model connection and your feed instructions. Temperature: 0.8; no roleplay generation preset is applied.'
      : target?.kind === 'profile' ? 'Uses the profile and its generation settings without changing your roleplay connection.'
      : availableTargets.length ? 'Choose a saved model or connection profile for this feed.'
      : 'Save a Chat Completion model or connection profile in Connection Manager, then refresh this panel.'
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
    if (item.generation) {
      const prompt = element('details', 'sth-scene')
      prompt.append(element('summary', '', `Instructions used · ${item.generation.presetName}`),
        element('p', 'sth-body', item.generation.instructions))
      card.append(prompt)
    }
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
      const chatChanged = next?.key !== snapshot?.key
      if (chatChanged) { selection.clear(); sceneLabel.value = ''; visibleCount = 100 }
      else if (next && snapshot) {
        selection = new Set([...selection].filter(index => {
          const before = snapshot!.messages.find(item => item.index === index)
          const after = next.messages.find(item => item.index === index)
          return before && after && sameMessage(before, after)
        }))
      }
      snapshot = next
      store = nextStore
      if (!presetsDirty && !operationPending && !generation.running) presetDraft = structuredClone(store.settings.instructionPresets)
      if (chatChanged) activePresetId = (next ? chatPresetSelections.get(next.key) || store.chats[next.key]?.instructionPresetId : undefined)
        || store.settings.activeInstructionPresetId
      renderPresets()
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
  async function persistSettings(input: Settings, origin: ChatSnapshot | null): Promise<void> {
    store = await repository.update(data => {
      data.settings = input
      const ids = new Set(input.instructionPresets.map(item => item.id))
      for (const savedChat of Object.values(data.chats)) {
        if (savedChat.instructionPresetId && !ids.has(savedChat.instructionPresetId)) delete savedChat.instructionPresetId
      }
      if (origin) data.chats[origin.key] = { ...data.chats[origin.key], name: origin.name,
        feeds: data.chats[origin.key]?.feeds || [], instructionPresetId: input.activeInstructionPresetId }
    })
    presetsDirty = false
  }
  async function saveSettings(): Promise<void> {
    if (operationPending || generation.running) return
    try {
      const input = settings()
      const origin = snapshot ? structuredClone(snapshot) : null
      operationPending = true; controls()
      await persistSettings(input, origin)
      status('Settings and instruction presets saved.')
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
      await persistSettings(input, origin)
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
    else if (button.hasAttribute('data-save-presets')) { void saveSettings() }
    else if (button.hasAttribute('data-new-preset')) editPreset('new')
    else if (button.hasAttribute('data-duplicate-preset')) editPreset('duplicate')
    else if (button.hasAttribute('data-delete-preset')) editPreset('delete')
    else if (button.hasAttribute('data-preview')) updatePreview(true)
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
    if (input.matches('[data-preset]')) {
      if (operationPending || generation.running) { presetSelect.value = activePresetId; return }
      selectPreset(input.value)
    } else if (input.matches('[data-index]')) {
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
  profile.addEventListener('change', () => { targetHint(); controls() })
  dialog.addEventListener('input', event => {
    const input = event.target as HTMLInputElement
    if (input.matches('[data-instructions], [data-preset-name]')) {
      capturePreset()
      const option = [...presetSelect.options].find(item => item.value === activePresetId)
      if (option) option.textContent = presetName.value.trim() || 'Unnamed preset'
      controls()
    } else if (input.matches('[data-label]')) updatePreview()
  })
  renderPresets()
  await refresh()
  return () => {
    disposed = true; ++revision
    clearTimeout(refreshTimer)
    generation.cancel(); unsubscribe()
    openButton.removeEventListener('click', open)
    dialog.close(); dialog.remove(); launcher.remove()
  }
}
