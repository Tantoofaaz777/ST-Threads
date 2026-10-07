import type { HostContext, ProxyPreset, SavedModelTarget } from './types'

const FORMATS: Record<string, string> = {
  custom_openai_responses: 'openai_responses', custom_claude_messages: 'claude_messages',
  custom_gemini_interactions: 'gemini_interactions', custom_gemini_generate_content: 'gemini_generate_content',
}
const ALIASES: Record<string, string> = {
  oai: 'openai', 'open-router': 'openrouter', google: 'makersuite', gemini: 'makersuite',
  'vertex-ai': 'vertexai', 'vertex ai': 'vertexai', 'nano-gpt': 'nanogpt', 'nano gpt': 'nanogpt',
  'silicon flow': 'siliconflow', 'workers-ai': 'workers_ai', 'workers ai': 'workers_ai',
  'cloudflare workers ai': 'workers_ai', 'z.ai': 'zai', glm: 'zai', 'mini-max': 'minimax',
  'mini max': 'minimax', 'moonshot ai': 'moonshot', 'aws-bedrock': 'aws_bedrock',
  'aws bedrock': 'aws_bedrock', bedrock: 'aws_bedrock', 'x.ai': 'xai', grok: 'xai',
}
const SECRET_KEYS: Record<string, string> = Object.fromEntries([
  'openai', 'opencode', 'openrouter', 'custom', 'claude', 'makersuite', 'vertexai', 'deepseek',
  'cohere', 'groq', 'moonshot', 'nanogpt', 'chutes', 'siliconflow', 'workers_ai', 'zai',
  'minimax', 'aws_bedrock', 'xai', 'pollinations',
].map(source => [source, `api_key_${source}`]))
const ENDPOINT_FIELDS: Record<string, string> = {
  opencode: 'opencode_endpoint', vertexai: 'vertexai_region', zai: 'zai_endpoint',
  siliconflow: 'siliconflow_endpoint', minimax: 'minimax_endpoint', moonshot: 'moonshot_endpoint',
  pollinations: 'pollinations_endpoint',
}
const PROXY_SOURCES = new Set(['custom', 'openai', 'claude', 'makersuite', 'vertexai', 'deepseek', 'moonshot', 'zai', 'xai'])

export function modelSource(target: SavedModelTarget, context: HostContext): string {
  const api = target.api.trim().toLowerCase()
  const mapping = context.CONNECT_API_MAP?.[api]
  if (mapping && mapping.selected !== 'openai') return ''
  const source = mapping?.source || (FORMATS[api] ? 'custom' : ALIASES[api] || api)
  return Object.hasOwn(SECRET_KEYS, source) ? source : ''
}

export function savedModels(context: HostContext): SavedModelTarget[] {
  const targets = context.extensionSettings.connectionManager?.modelTargets
  if (!Array.isArray(targets)) return []
  return targets.filter(target => target?.kind === 'tauritavern.modelTarget' && target.mode === 'cc'
    && typeof target.id === 'string' && target.id.trim()
    && typeof target.api === 'string' && target.api.trim()
    && typeof target.model === 'string' && target.model.trim() && modelSource(target, context))
    .map(target => structuredClone(target))
    .sort((a, b) => (a.name || a.model).localeCompare(b.name || b.model, 'en-US'))
}

// Proxy presets are a live named export in ST/TT; importing the existing host module
// reads that list without replaying slash commands or changing the active connection.
export async function readHostProxyPresets(): Promise<ProxyPreset[]> {
  const hostModuleUrl = '/scripts/openai.js'
  const module = await import(hostModuleUrl)
  if (!Array.isArray(module.proxies)) throw new Error('Saved reverse proxy presets are unavailable.')
  return structuredClone(module.proxies)
}

export async function savedModelPayload(target: SavedModelTarget, context: HostContext, prompt: string,
  maxTokens: number, signal: AbortSignal, readProxies: () => Promise<ProxyPreset[]>): Promise<Record<string, unknown>> {
  signal.throwIfAborted()
  const source = modelSource(target, context)
  if (!source) throw new Error('This saved model does not use a supported Chat Completion provider.')
  const payload: Record<string, unknown> = {
    type: 'quiet', stream: true, messages: [{ role: 'user', content: prompt }],
    model: target.model.trim(), chat_completion_source: source, max_tokens: maxTokens, temperature: 0.8,
  }
  const format = target['custom-api-format']?.trim() || FORMATS[target.api.trim().toLowerCase()] || 'openai_compat'
  if (source === 'custom') {
    payload.custom_api_format = format
    payload.custom_claude_prompt_caching = target.adapterHints?.claudePromptCaching === 'enabled'
    payload.custom_openai_responses_websocket = target.adapterHints?.openaiResponsesMode === 'websocket'
  } else if (source === 'opencode') payload.opencode_api_format = target['custom-api-format']?.trim() || 'openai_compat'

  const endpoint = target['api-url']?.trim() || ''
  if (ENDPOINT_FIELDS[source] && endpoint) payload[ENDPOINT_FIELDS[source]] = endpoint
  if (source === 'custom') payload.custom_url = endpoint
  if (source === 'vertexai') payload.vertexai_auth_mode = target.secretRef?.key === 'vertexai_service_account_json' ? 'full' : 'express'

  const proxyName = target.proxy?.trim()
  if (proxyName && proxyName !== 'None') {
    if (!PROXY_SOURCES.has(source)) throw new Error(`Saved reverse proxies are not supported for ${source}. Update the saved model.`)
    const proxies = await readProxies()
    signal.throwIfAborted()
    const proxy = proxies.find(item => item.name === proxyName)
    if (!proxy?.url?.trim()) throw new Error(`The saved reverse proxy "${proxyName}" is missing. Update the saved model.`)
    payload.reverse_proxy = proxy.url.trim()
    payload.proxy_password = proxy.password || ''
    if (source === 'custom') payload.custom_url = ''
  } else if (target.secretRef) {
    const expected = source === 'vertexai' && payload.vertexai_auth_mode === 'full'
      ? 'vertexai_service_account_json' : SECRET_KEYS[source]
    if (target.secretRef.key !== expected || !target.secretRef.id?.trim()) {
      throw new Error('The saved model credential reference does not match its provider. Update the saved model in Connection Manager.')
    }
    payload.secret_id = target.secretRef.id.trim()
  } else if (source === 'custom' && endpoint) {
    // The native custom route with an explicit proxy password skips active-key lookup.
    // This allows intentionally keyless local endpoints without using the roleplay key.
    payload.custom_url = ''
    payload.reverse_proxy = endpoint
    payload.proxy_password = ''
  } else if (!(source === 'pollinations' && endpoint === 'anonymous')) {
    throw new Error('This saved model has no credential reference. Update it in Connection Manager before generating.')
  }
  if (source === 'custom' && !payload.custom_url && !payload.reverse_proxy) {
    throw new Error('The saved model has no endpoint. Update it in Connection Manager.')
  }
  signal.throwIfAborted()
  return payload
}
