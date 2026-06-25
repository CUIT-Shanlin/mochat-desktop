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
        chatGateway?: string | null
      }
      selectFiles: () => Promise<string[]>
      setUser: (payload: { username: string; userId: string | number }) => Promise<{ ok: boolean; username: string; userId: string }>
      seedUserIdFor: (username: string) => Promise<string | null>
      usernameByUserId: (userId: string | number) => Promise<string | null>
      decryptHistory: (payload: { items: Array<Record<string, unknown>>; kind: 'private' | 'group'; peerUsername?: string | null }) => Promise<Array<Record<string, unknown> & { decryptedText?: string }>>
      chat: {
        connect: (payload: { gatewayUrl: string }) => Promise<{ ok: boolean }>
        disconnect: () => Promise<{ ok: boolean }>
        sendPrivateText: (payload: {
          sessionId: string
          clientMsgId: number
          conversationId: string | number
          toUid: string | number
          text: string
          fromUsername: string
          peerUsername: string
        }) => Promise<{ ok: boolean }>
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