export type EntityId = string | number

export type ConversationKind = 'private' | 'group'

export interface Session {
  userId: EntityId
  username: string
  sessionId: string
  demo?: boolean
}

export interface Conversation {
  id: EntityId
  targetId: EntityId
  kind: ConversationKind
  name: string
  initials: string
  color: string
  preview: string
  time: string
  unread: number
  online?: boolean
}

export interface BackendFriend {
  conversationId: EntityId
  userId: EntityId
  username: string
}

export interface BackendGroup {
  groupId: EntityId
  name: string
  ownerUserId: EntityId
}

export interface BackendFriendRequest {
  requestId: EntityId
  fromUserId: EntityId
  toUserId: EntityId
  sign: string
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled'
  createdAtEpochMillis: number
  handledAtEpochMillis?: number | null
}

export interface ChatMessage {
  id: EntityId
  conversationId: EntityId
  fromMe: boolean
  text: string
  time: string
  status?: 'sending' | 'sent' | 'read' | 'failed'
  mediaUrl?: string
  fileName?: string
}

export interface BackendTextMessage {
  seq: EntityId
  msgId: EntityId
  conversationId: EntityId
  senderUserId: EntityId
  serverTimeMs: number
  text: string
  messageType: 'text' | 'image' | 'video' | 'audio' | 'file'
}

export interface FriendRequest {
  id: EntityId
  name: string
  userId: EntityId
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
