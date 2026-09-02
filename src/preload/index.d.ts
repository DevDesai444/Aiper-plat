import type { AiperApi } from './index'

declare global {
  interface Window {
    aiper: AiperApi
  }
}

export {}
