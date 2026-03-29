// Worker entry point — runs MediaPipe inference off the main thread.
// Wraps the existing createMediaPipeBackend() so all WASM/model loading
// and detectForVideo() calls happen here instead of blocking the UI.

import type { WorkerRequest, WorkerResponse } from './worker-protocol'

import { errorMessageFrom } from '@moeru/std'

import { createMediaPipeBackend } from './mediapipe'

// NOTICE: MediaPipe's WASM (Emscripten) runtime expects DOM APIs that don't exist in
// Workers. We polyfill the minimum surface: `document.createElement('canvas')` →
// `OffscreenCanvas`, and alias `window` to `globalThis`. Without these, WASM GL context
// creation fails with "document is not defined".
if (typeof document === 'undefined') {
  ;(globalThis as any).document = {
    createElement(tag: string) {
      if (tag === 'canvas')
        return new OffscreenCanvas(1, 1)
      throw new Error(`Cannot create <${tag}> in Worker`)
    },
    createElementNS(_ns: string, tag: string) {
      if (tag === 'canvas')
        return new OffscreenCanvas(1, 1)
      throw new Error(`Cannot create <${tag}> in Worker`)
    },
  }
}
if (typeof window === 'undefined') {
  ;(globalThis as any).window = globalThis
}

// NOTICE: MediaPipe's bundled WASM loader calls `self.import(url)` to load the Emscripten
// factory script (vision_wasm_internal.js). That script uses `var ModuleFactory = ...` which
// only leaks to the global scope when executed as a classic script (not an ES module).
// Module Workers don't support `importScripts`, and `import()` would scope `var` locally.
// We polyfill `self.import` with fetch + indirect eval so `var` declarations become global.
if (typeof (globalThis as any).import !== 'function') {
  ;(globalThis as any).import = async (url: string) => {
    const res = await fetch(url)
    const text = await res.text()
    // Indirect eval runs in global scope, making `var ModuleFactory` a global.
    ;(0, eval)(text)
  }
}

const backend = createMediaPipeBackend()

function post(msg: WorkerResponse) {
  globalThis.postMessage(msg)
}

globalThis.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data

  switch (msg.type) {
    case 'init': {
      try {
        await backend.init(msg.config)
        post({ type: 'init-result', id: msg.id })
      }
      catch (err) {
        console.error('[MediaPipe Worker] init failed:', err)
        post({ type: 'init-result', id: msg.id, error: errorMessageFrom(err) ?? 'init failed' })
      }
      break
    }

    case 'run': {
      try {
        const result = await backend.run(msg.frame, msg.jobs, msg.nowMs)
        msg.frame.close()
        post({ type: 'run-result', id: msg.id, result })
      }
      catch (err) {
        console.error('[MediaPipe Worker] run failed:', err)
        msg.frame.close()
        post({ type: 'run-result', id: msg.id, error: errorMessageFrom(err) ?? 'run failed' })
      }
      break
    }

    case 'update-config': {
      try {
        await backend.init(msg.config)
        post({ type: 'update-config-result', id: msg.id })
      }
      catch (err) {
        console.error('[MediaPipe Worker] config update failed:', err)
        post({ type: 'update-config-result', id: msg.id, error: errorMessageFrom(err) ?? 'update-config failed' })
      }
      break
    }
  }
})
