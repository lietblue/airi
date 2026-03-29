// Main-thread proxy that implements MocapBackend by forwarding inference
// to a dedicated Web Worker via postMessage + ImageBitmap transfer.

import type { MocapBackend, MocapConfig, MocapJob, PerceptionPartial } from '../types'
import type { WorkerRequest, WorkerResponse } from './worker-protocol'

export function createWorkerBackend(): MocapBackend {
  let worker: Worker | null = null
  let busy = false
  let nextId = 0
  const pending = new Map<number, {
    resolve: (value: any) => void
    reject: (reason: any) => void
  }>()

  function post(msg: WorkerRequest, transfer?: Transferable[]) {
    worker!.postMessage(msg, transfer ?? [])
  }

  function request<T>(msg: WorkerRequest, transfer?: Transferable[]): Promise<T> {
    return new Promise((resolve, reject) => {
      pending.set(msg.id, { resolve, reject })
      post(msg, transfer)
    })
  }

  function handleMessage(event: MessageEvent<WorkerResponse>) {
    const msg = event.data
    const entry = pending.get(msg.id)
    if (!entry)
      return
    pending.delete(msg.id)

    if ('error' in msg && msg.error) {
      entry.reject(new Error(msg.error))
      return
    }

    if (msg.type === 'run-result') {
      entry.resolve(msg.result ?? {})
    }
    else {
      entry.resolve(undefined)
    }
  }

  function handleError(e: ErrorEvent) {
    console.error('[WorkerBackend] Worker error:', e.message)
    for (const [, entry] of pending)
      entry.reject(new Error(`Worker crashed: ${e.message}`))
    pending.clear()
    busy = false
  }

  async function init(config: MocapConfig): Promise<void> {
    if (!worker) {
      worker = new Worker(
        new URL('./mediapipe-worker.ts', import.meta.url),
        { type: 'module' },
      )
      worker.addEventListener('message', handleMessage)
      worker.addEventListener('error', handleError)
    }

    const id = nextId++
    await request({ type: 'init', id, config })
  }

  function isBusy(): boolean {
    return busy
  }

  async function run(
    frame: TexImageSource,
    jobs: MocapJob[],
    nowMs: number,
  ): Promise<PerceptionPartial> {
    busy = true
    try {
      const bitmap = await createImageBitmap(frame as ImageBitmapSource)
      const id = nextId++
      const result = await request<PerceptionPartial>(
        { type: 'run', id, frame: bitmap, jobs, nowMs },
        [bitmap],
      )
      return result
    }
    finally {
      busy = false
    }
  }

  function dispose() {
    if (worker) {
      worker.terminate()
      worker = null
    }
    for (const [, entry] of pending)
      entry.reject(new Error('Worker disposed'))
    pending.clear()
    busy = false
  }

  return { init, isBusy, run, dispose }
}
