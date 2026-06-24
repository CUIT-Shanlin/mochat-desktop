export {}

declare global {
  interface Window {
    mochatDesktop?: {
      platform: string
      launchConfig?: {
        server?: string | null
        callServer?: string | null
        callWs?: string | null
        mediaServer?: string | null
      }
      selectFiles: () => Promise<string[]>
      window: {
        minimize: () => void
        maximize: () => void
        close: () => void
      }
    }
  }
}
