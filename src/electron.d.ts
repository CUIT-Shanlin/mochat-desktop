export {}

declare global {
  interface Window {
    mochatDesktop?: {
      platform: string
      selectFiles: () => Promise<string[]>
      window: {
        minimize: () => void
        maximize: () => void
        close: () => void
      }
    }
  }
}
