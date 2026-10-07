import { createHost } from './host'
import { mountUi } from './ui'

let dispose: (() => void) | undefined
let pending: Promise<void> | undefined
let enabled = true

async function initialize(): Promise<void> {
  if (!enabled || dispose) return
  if (pending) return pending
  pending = (async () => {
    await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__)
    if (!enabled) return
    const tavern = window.SillyTavern
    if (!tavern) throw new Error('The SillyTavern context is not available yet.')
    const cleanup = await mountUi(createHost(() => tavern.getContext(), window.__TAURITAVERN__))
    if (!enabled) cleanup()
    else dispose = cleanup
  })().catch(error => { console.error('[ST Threads] Initialization failed:', error) })
    .finally(() => { pending = undefined })
  return pending
}

export function onDisable(): void { enabled = false; dispose?.(); dispose = undefined }
export function onEnable(): void { enabled = true; void initialize() }

// Defer asynchronous startup, including auto-fired APP_READY, outside the host loader.
const start = () => { setTimeout(() => { void initialize() }, 0) }
const context = window.SillyTavern?.getContext()
if (context?.eventTypes.APP_READY) context.eventSource.on(context.eventTypes.APP_READY, start)
else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
else start()
