import type { MocapConfig, MocapJob, PerceptionPartial } from '../types'

// Messages FROM main thread TO worker

export interface WorkerInitMessage {
  type: 'init'
  id: number
  config: MocapConfig
}

export interface WorkerRunMessage {
  type: 'run'
  id: number
  frame: ImageBitmap
  jobs: MocapJob[]
  nowMs: number
}

export interface WorkerUpdateConfigMessage {
  type: 'update-config'
  id: number
  config: MocapConfig
}

export type WorkerRequest = WorkerInitMessage | WorkerRunMessage | WorkerUpdateConfigMessage

// Messages FROM worker TO main thread

export interface WorkerInitResult {
  type: 'init-result'
  id: number
  error?: string
}

export interface WorkerRunResult {
  type: 'run-result'
  id: number
  result?: PerceptionPartial
  error?: string
}

export interface WorkerUpdateConfigResult {
  type: 'update-config-result'
  id: number
  error?: string
}

export type WorkerResponse = WorkerInitResult | WorkerRunResult | WorkerUpdateConfigResult
