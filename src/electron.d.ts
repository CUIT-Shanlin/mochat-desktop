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
      chat: {
        connect: (payload: { gatewayUrl: string }) => Promise<{ ok: boolean }>
        disconnect: () => Promise<{ ok: boolean }>
        sendPrivateText: (payload: { sessionId: string; clientMsgId: number; conversationId: string | number; toUid: string | number; text: string }) => Promise<{ ok: boolean }>
        sendGroupText: (payload: { sessionId: string; clientMsgId: number; conversationId: string | number; groupId: string | number; text: string }) => Promise<{ ok: boolean }>
        sendPrivateMedia: (payload: { sessionId: string; clientMsgId: number; conversationId: string | number; toUid: string | number; media: Record<string, unknown> }) => Promise<{ ok: boolean }>
        sendGroupMedia: (payload: { sessionId: string; clientMsgId: number; conversationId: string | number; groupId: string | number; media: Record<string, unknown> }) => Promise<{ ok: boolean }>
        sendReceiveAck: (payload: { sessionId: string; conversationId: string | number; latestReceivedSeq: string | number }) => Promise<{ ok: boolean }>
        onEvent: (listener: (payload: Record<string, unknown>) => void) => () => void
      }
      window: {
        minimize: () => void
        maximize: () => void
        close: () => void
      }
    }
  }
}
