import { describe, expect, test } from 'bun:test'
import { createHost } from '../src/host'
import { savedModelPayload } from '../src/models'
import { normalizeSettings } from '../src/store'
import type { HostContext, SavedModelTarget } from '../src/types'
import { context } from './fixtures'

function model(overrides: Partial<SavedModelTarget> = {}): SavedModelTarget {
  return { schemaVersion: 1, kind: 'tauritavern.modelTarget', mode: 'cc', id: 'saved-model', name: 'Feed model',
    api: 'custom', model: 'fandom-model', 'api-url': 'http://localhost:8000/v1',
    secretRef: { key: 'api_key_custom', id: 'saved-credential' }, ...overrides }
}
function modelContext(target = model()): HostContext {
  const ctx = context()
  ctx.extensionSettings.connectionManager = { modelTargets: [target] }
  ctx.ChatCompletionService = { async processRequest() { return { content: 'Model response' } } }
  return ctx
}
const noProxies = async () => []

describe('saved TauriTavern models', () => {
  test('lists native saved Chat Completion models separately from profiles and excludes Text Completion', () => {
    const ctx = modelContext()
    ctx.extensionSettings.connectionManager!.modelTargets!.push(model({ id: 'text-model', mode: 'tc' }),
      model({ id: 'unsupported', api: 'kobold' }))
    const targets = createHost(() => ctx, {}).listGenerationTargets()
    expect(targets.map(item => [item.kind, item.id])).toEqual([['model', 'saved-model'], ['profile', 'chat-profile']])
    expect(createHost(() => ctx).listGenerationTargets().map(item => item.kind)).toEqual(['profile'])
    delete ctx.ConnectionManagerRequestService
    expect(createHost(() => ctx, {}).listGenerationTargets().map(item => item.kind)).toEqual(['model'])
  })
  test('sends the saved provider, endpoint and credential with no active chat settings or preset mutation', async () => {
    const ctx = modelContext(model({ 'custom-api-format': 'claude_messages', adapterHints: { claudePromptCaching: 'enabled' } }))
    ;(ctx as any).chatCompletionSettings = { chat_completion_source: 'openrouter', custom_url: 'https://roleplay.example/v1',
      temperature: 0.1, custom_openai_responses_websocket: true }
    const before = structuredClone({ chat: ctx.chat, settings: ctx.extensionSettings, current: (ctx as any).chatCompletionSettings })
    let calls = 0
    ctx.ConnectionManagerRequestService!.sendRequest = async () => { throw new Error('Profile service must not be used') }
    const controller = new AbortController()
    ctx.ChatCompletionService!.processRequest = async (payload, options, extract, signal) => {
      calls++
      expect(payload).toMatchObject({ type: 'quiet', stream: true, model: 'fandom-model', chat_completion_source: 'custom',
        custom_url: 'http://localhost:8000/v1', custom_api_format: 'claude_messages', secret_id: 'saved-credential',
        max_tokens: 1234, temperature: 0.8, custom_claude_prompt_caching: true, custom_openai_responses_websocket: false,
        messages: [{ role: 'user', content: 'My scene and instructions' }] })
      expect(payload).not.toHaveProperty('reverse_proxy')
      expect(options).toEqual({})
      expect(extract).toBe(true)
      expect(signal).toBe(controller.signal)
      return async function* () { yield { text: 'One' }; yield { text: 'One two' } }
    }
    const progress: string[] = []
    expect(await createHost(() => ctx, {}).generate({ kind: 'model', id: 'saved-model' },
      'My scene and instructions', 1234, controller.signal, text => progress.push(text))).toBe('One two')
    expect(progress).toEqual(['One', 'One two'])
    expect(calls).toBe(1)
    expect({ chat: ctx.chat, settings: ctx.extensionSettings, current: (ctx as any).chatCompletionSettings }).toEqual(before)
  })
  test.each([
    ['custom_openai_responses', 'custom', 'openai_responses', 'api_key_custom'],
    ['custom_claude_messages', 'custom', 'claude_messages', 'api_key_custom'],
    ['custom_gemini_interactions', 'custom', 'gemini_interactions', 'api_key_custom'],
    ['custom_gemini_generate_content', 'custom', 'gemini_generate_content', 'api_key_custom'],
    ['google', 'makersuite', undefined, 'api_key_makersuite'],
    ['open-router', 'openrouter', undefined, 'api_key_openrouter'],
  ])('replays the %s provider alias and format', async (api, source, format, key) => {
    const target = model({ api: api!, secretRef: { key: key!, id: 'credential' } })
    const payload = await savedModelPayload(target, context(), 'Scene', 4096, new AbortController().signal, noProxies)
    expect(payload.chat_completion_source).toBe(source)
    expect(payload.custom_api_format).toBe(format)
    expect(payload.secret_id).toBe('credential')
  })
  test('uses the saved Vertex service account and region, and replays endpoint-specific options', async () => {
    const signal = new AbortController().signal
    const vertex = await savedModelPayload(model({ api: 'vertexai', 'api-url': 'europe-west4',
      secretRef: { key: 'vertexai_service_account_json', id: 'service-account' } }), context(), 'Scene', 4096, signal, noProxies)
    expect(vertex).toMatchObject({ vertexai_auth_mode: 'full', vertexai_region: 'europe-west4', secret_id: 'service-account' })
    const opencode = await savedModelPayload(model({ api: 'opencode', 'api-url': 'zen', 'custom-api-format': 'gemini',
      secretRef: { key: 'api_key_opencode', id: 'code-key' } }), context(), 'Scene', 4096, signal, noProxies)
    expect(opencode).toMatchObject({ opencode_endpoint: 'zen', opencode_api_format: 'gemini' })
    const responses = await savedModelPayload(model({ api: 'custom_openai_responses',
      adapterHints: { openaiResponsesMode: 'websocket' } }), context(), 'Scene', 4096, signal, noProxies)
    expect(responses.custom_openai_responses_websocket).toBe(true)
  })
  test('uses the named reverse proxy, rejects missing proxies and never substitutes the active connection', async () => {
    const target = model({ proxy: 'Feed proxy', secretRef: undefined })
    const signal = new AbortController().signal
    const payload = await savedModelPayload(target, context(), 'Scene', 4096, signal,
      async () => [{ name: 'Feed proxy', url: 'https://feed.example/v1', password: 'proxy-password' }])
    expect(payload).toMatchObject({ custom_url: '', reverse_proxy: 'https://feed.example/v1', proxy_password: 'proxy-password' })
    expect(payload).not.toHaveProperty('secret_id')
    await expect(savedModelPayload(target, context(), 'Scene', 4096, signal, noProxies)).rejects.toThrow('is missing')
  })
  test('keyless custom endpoints do not fall back to the active API key', async () => {
    const payload = await savedModelPayload(model({ secretRef: undefined }), context(), 'Scene', 4096,
      new AbortController().signal, noProxies)
    expect(payload).toMatchObject({ custom_url: '', reverse_proxy: 'http://localhost:8000/v1', proxy_password: '' })
    expect(payload).not.toHaveProperty('secret_id')
  })
  test('rejects missing or mismatched credentials before calling the model service', async () => {
    for (const target of [model({ api: 'claude', secretRef: undefined }), model({ api: 'claude' })]) {
      const ctx = modelContext(target)
      let called = false
      ctx.ChatCompletionService!.processRequest = async () => { called = true; return { content: 'Wrong' } }
      await expect(createHost(() => ctx, {}).generate({ kind: 'model', id: target.id }, 'Scene', 4096,
        new AbortController().signal, () => {})).rejects.toThrow('reference')
      expect(called).toBe(false)
    }
  })
  test('cancels while loading proxies and freezes the model before asynchronous preparation', async () => {
    const target = model({ proxy: 'Proxy' })
    const ctx = modelContext(target)
    let called = false
    ctx.ChatCompletionService!.processRequest = async payload => {
      called = true
      expect(payload.model).toBe('fandom-model')
      return { content: 'Saved model response' }
    }
    const host = createHost(() => ctx, {}, async () => {
      target.model = 'different-model'
      return [{ name: 'Proxy', url: 'https://feed.example/v1', password: '' }]
    })
    await host.generate({ kind: 'model', id: target.id }, 'Scene', 4096, new AbortController().signal, () => {})
    expect(called).toBe(true)
    called = false
    const controller = new AbortController()
    const canceling = createHost(() => ctx, {}, async () => { controller.abort(); return [] })
    await expect(canceling.generate({ kind: 'model', id: target.id }, 'Scene', 4096,
      controller.signal, () => {})).rejects.toHaveProperty('name', 'AbortError')
    expect(called).toBe(false)
  })
  test('a removed model never falls back to a profile with the same ID', async () => {
    const ctx = modelContext(model({ id: 'chat-profile' }))
    const host = createHost(() => ctx, {})
    expect(host.listGenerationTargets().filter(item => item.id === 'chat-profile')).toHaveLength(2)
    ctx.extensionSettings.connectionManager!.modelTargets = []
    await expect(host.generate({ kind: 'model', id: 'chat-profile' }, 'Scene', 4096,
      new AbortController().signal, () => {})).rejects.toThrow('available')
    expect(await host.generate({ kind: 'profile', id: 'chat-profile' }, 'Scene', 4096,
      new AbortController().signal, () => {})).toBe('Hello world')
  })
  test('migrates existing profile selection and persists saved model identity separately', () => {
    expect(normalizeSettings({ profileId: 'existing-profile' }).generationTargetKind).toBe('profile')
    const settings = normalizeSettings({ profileId: 'saved-id', generationTargetKind: 'model' })
    expect(normalizeSettings(settings)).toMatchObject({ profileId: 'saved-id', generationTargetKind: 'model' })
  })
  test('subscribes to model and profile changes and removes those listeners on cleanup', () => {
    const ctx = modelContext()
    const names = ['MODEL_TARGET_CREATED', 'MODEL_TARGET_UPDATED', 'MODEL_TARGET_DELETED',
      'CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED']
    ctx.eventTypes = Object.fromEntries(names.map(name => [name, name.toLowerCase()]))
    const subscribed: string[] = []
    const removed: string[] = []
    ctx.eventSource.on = event => subscribed.push(event)
    ctx.eventSource.removeListener = event => removed.push(event)
    const dispose = createHost(() => ctx, {}).subscribe(() => {})
    expect(subscribed).toEqual(names.map(name => name.toLowerCase()))
    dispose()
    expect(removed).toEqual(subscribed)
  })
})
