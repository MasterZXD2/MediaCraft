/// <reference types="vite/client" />

import type { MediaCraftApi } from '../../preload'

declare global {
  interface Window {
    api: MediaCraftApi
  }
}

export {}
