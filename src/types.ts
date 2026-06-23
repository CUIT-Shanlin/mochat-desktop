export type ConversationKind = 'private' | 'group'

export interface Session {
  userId: number
  username: string
  sessionId: string
  demo?: boolean
}

export interface Conversation {
  id: number
  targetId: number
  kind: ConversationKind
  name: string
  initials: string
  color: string
  preview: string
  time: string
  unread: number
  online?: boolean
}

export interface ChatMessage {
  id: number
  conversationId: number
  fromMe: boolean
  text: string
  time: string
  status?: 'sending' | 'sent' | 'read' | 'failed'
  mediaUrl?: string
  fileName?: string
}

export interface FriendRequest {
  id: number
  name: string
  userId: number
  message: string
  status: 'pending' | 'accepted' | 'rejected'
}

export type MediaMessageType = 'image' | 'video' | 'audio' | 'file'

export interface MediaUpload {
  mediaId: string
  mediaUrl: string
  thumbnailUrl?: string
  objectName: string
  fileSize: number
  mimeType: string
  fileName: string
  waveformData?: string
}

export interface CallSession {
  callId?: string
  roomName: string
  fromUserId?: number
  toUserId?: number
  groupId?: number
  token?: string
  livekitUrl?: string
  queuedUserIds?: number[]
}

export interface CallSignalPayload {
  type: string
  callId?: string
  fromUserId?: number
  toUserId?: number
  groupId?: number
  roomName?: string
  token?: string
  livekitUrl?: string
  timestampMillis?: number
  message?: string
}
