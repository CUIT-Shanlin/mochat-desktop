export type EntityId = string | number

export type ConversationKind = 'private' | 'group'

export interface Session {
  userId: EntityId
  username: string
  sessionId: string
  demo?: boolean
}

export interface BackendHistoryItem {
  seq: EntityId
  msgId: EntityId
  conversationId: EntityId
  serverTimeMs: number
  payloadBase64: string
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
  seq?: EntityId
  clientMsgId?: EntityId
  mediaUrl?: string
  thumbnailUrl?: string
  fileName?: string
  mimeType?: string
  mediaType?: 'image' | 'video' | 'audio' | 'file'
  fileSize?: number | string
  width?: number
  height?: number
  duration?: number
  waveformData?: string
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

export interface ChatGatewayContent {
  encryptedText?: {
    nonce?: string
    ciphertext?: string
  }
  plainText?: {
    text?: string
  }
  media?: {
    type?: string
    mediaUrl?: string
    thumbnailUrl?: string
    fileSize?: string | number
    mimeType?: string
    fileName?: string
    duration?: number
    width?: number
    height?: number
    previewText?: string
    waveformData?: string
  }
}

export interface ChatGatewayDelivery {
  msgId: EntityId
  seq: EntityId
  serverTimeMs: number
  conversationId: EntityId
  fromUid: EntityId
  contents?: ChatGatewayContent[]
  deliveryKind?: 'private' | 'group'
  payloadType?: 'privatePayload' | 'groupPayload'
  toUid?: EntityId
  groupId?: EntityId
  privatePayload?: {
    toUid?: EntityId
    contents?: ChatGatewayContent[]
  }
  groupPayload?: {
    groupId?: EntityId
    contents?: ChatGatewayContent[]
  }
}

export interface ChatGatewaySendAck {
  clientMsgId: EntityId
  msgId: EntityId
  seq: EntityId
  serverTimeMs: number
}

export interface ChatGatewayDeliveredAck {
  conversationId: EntityId
  toUid: EntityId
  latestReceivedSeq: EntityId
  serverTimeMs: number
}

export interface ChatGatewayError {
  errorCode: number
  message: string
}

export interface CallSession {
  callId?: string
  roomName: string
  fromUserId?: EntityId
  toUserId?: EntityId
  groupId?: EntityId
  callKind?: 'voice' | 'video'
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
  callKind?: 'voice' | 'video'
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
  callKind?: 'voice' | 'video'
}
