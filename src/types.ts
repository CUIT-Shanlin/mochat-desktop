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
}

export interface FriendRequest {
  id: number
  name: string
  userId: number
  message: string
  status: 'pending' | 'accepted' | 'rejected'
}
