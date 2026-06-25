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
  ownerUserId?: EntityId
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

export interface BackendGroupJoinRequest {
  requestId: EntityId
  groupId: EntityId
  fromUserId: EntityId
  sign: string
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled'
  createdAtEpochMillis: number
  handledByUserId?: EntityId | null
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
  fromUserId?: EntityId
  toUserId?: EntityId
  groupId?: EntityId
  token?: string
  livekitUrl?: string
  queuedUserIds?: EntityId[]
}

export interface CallSignalPayload {
  type: string
  callId?: string
  fromUserId?: EntityId
  toUserId?: EntityId
  groupId?: EntityId
  roomName?: string
  token?: string
  livekitUrl?: string
  timestampMillis?: number
  message?: string
}

export interface IncomingCall {
  type: 'call_invite' | 'call_group_started'
  callId?: string
  fromUserId: EntityId
  groupId?: EntityId
  roomName: string
}
