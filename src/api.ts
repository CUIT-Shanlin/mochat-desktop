import type { BackendFriend, BackendFriendRequest, BackendGroup, CallSession, CallSignalPayload, Conversation, EntityId, MediaMessageType, MediaUpload, Session } from './types'

const demoEnabled = import.meta.env.VITE_DEMO_MODE !== 'false'

export function getApiBaseUrl() {
  return (localStorage.getItem('mochat.server') || import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080').replace(/\/$/, '')
}

export function getCallBaseUrl() {
  return (localStorage.getItem('mochat.callServer') || import.meta.env.VITE_CALL_BASE_URL || 'http://localhost:8090').replace(/\/$/, '')
}

export function getCallWsUrl() {
  const configured = localStorage.getItem('mochat.callWs') || import.meta.env.VITE_CALL_WS_URL
  return (configured || getCallBaseUrl().replace(/^http/, 'ws')).replace(/\/$/, '')
}

export function getMediaBaseUrl() {
  return (localStorage.getItem('mochat.mediaServer') || import.meta.env.VITE_MEDIA_BASE_URL || 'http://localhost:8083').replace(/\/$/, '')
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const text = await response.text().catch(() => '')
  const body = parseJsonPreservingLargeIntegers(text)
  const errorMessage = typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : `请求失败 (${response.status})`
  if (!response.ok || body.success === false) throw new Error(errorMessage)
  return (body.data ?? body) as T
}

const apiRequest = <T>(path: string, init?: RequestInit) => request<T>(getApiBaseUrl(), path, init)
const callRequest = <T>(path: string, init?: RequestInit) => request<T>(getCallBaseUrl(), path, init)
const mediaRequest = <T>(path: string, init?: RequestInit) => request<T>(getMediaBaseUrl(), path, init)

function parseJsonPreservingLargeIntegers(text: string) {
  if (!text) return {}
  try {
    return JSON.parse(text.replace(/(:\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function generatePublicKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
}

function identityKeyFor(username: string) {
  const storageKey = `mochat.identityKey.${username}`
  const existing = localStorage.getItem(storageKey)
  if (existing) return existing
  const publicKey = generatePublicKey()
  localStorage.setItem(storageKey, publicKey)
  return publicKey
}

export const api = {
  async login(username: string): Promise<Session> {
    try {
      const publicKey = identityKeyFor(username)
      return await apiRequest<Session>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, publicKey }),
      })
    } catch (error) {
      if (!demoEnabled) throw error
      return { userId: 10001, username, sessionId: `demo-${crypto.randomUUID()}`, demo: true }
    }
  },
  friends: (sessionId: string) => apiRequest<{ friends?: BackendFriend[] }>(`/friends?sessionId=${encodeURIComponent(sessionId)}`),
  groups: (sessionId: string) => apiRequest<{ groups?: BackendGroup[] }>(`/groups?sessionId=${encodeURIComponent(sessionId)}`),
  history: (sessionId: string, conversationId: EntityId) => apiRequest<{ items: unknown[] }>(`/history?sessionId=${encodeURIComponent(sessionId)}&conversationId=${conversationId}&limit=50`),
  createGroup: (sessionId: string, name: string) => apiRequest<{ group: BackendGroup }>('/groups', { method: 'POST', body: JSON.stringify({ sessionId, name }) }),
  sendFriendRequest: (sessionId: string, toUserId: EntityId, sign = '') => apiRequest<{ request: BackendFriendRequest }>('/friends/requests', { method: 'POST', body: JSON.stringify({ sessionId, toUserId, sign }) }),
  receivedFriendRequests: (sessionId: string) => apiRequest<{ requests?: BackendFriendRequest[] }>(`/friends/requests/received?sessionId=${encodeURIComponent(sessionId)}`),
  handleFriendRequest: (sessionId: string, requestId: EntityId, action: 'accept' | 'reject') => apiRequest<{ request: BackendFriendRequest }>(`/friends/requests/${requestId}/handle`, { method: 'POST', body: JSON.stringify({ sessionId, action }) }),
  startPrivateCall: (sessionId: string, toUserId: EntityId) => callRequest<CallSession>('/calls/private/invite', { method: 'POST', body: JSON.stringify({ sessionId, toUserId }) }),
  startGroupCall: (sessionId: string, groupId: EntityId) => callRequest<CallSession>('/calls/group/start', { method: 'POST', body: JSON.stringify({ sessionId, groupId }) }),
  joinGroupCall: (sessionId: string, roomName: string) => callRequest<CallSession>('/calls/group/join', { method: 'POST', body: JSON.stringify({ sessionId, roomName }) }),
  leaveGroupCall: (sessionId: string, roomName: string) => callRequest<{ left: boolean }>('/calls/group/leave', { method: 'POST', body: JSON.stringify({ sessionId, roomName }) }),
  async uploadMedia(file: File): Promise<MediaUpload> {
    const form = new FormData()
    form.append('file', file)
    const response = await fetch(`${getMediaBaseUrl()}/media/upload`, { method: 'POST', body: form })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.success === false) throw new Error(body.message || `上传失败 (${response.status})`)
    return body.data as MediaUpload
  },
  sendMultimediaMessage(sessionId: string, conversation: Conversation, media: MediaUpload, messageType = inferMediaType(media.mimeType)) {
    const payload = {
      sessionId,
      messageType,
      mediaUrl: media.mediaUrl,
      thumbnailUrl: media.thumbnailUrl || null,
      fileSize: media.fileSize,
      mimeType: media.mimeType,
      fileName: media.fileName,
      waveformData: media.waveformData || null,
    }
    if (conversation.kind === 'group') {
      return mediaRequest<{ clientMsgId: number; conversationId: number }>('/messages/send-multimedia/group', {
        method: 'POST',
        body: JSON.stringify({ ...payload, groupId: conversation.targetId, conversationId: conversation.id }),
      })
    }
    return mediaRequest<{ clientMsgId: number; conversationId: number }>('/messages/send-multimedia/private', {
      method: 'POST',
      body: JSON.stringify({ ...payload, toUid: conversation.targetId }),
    })
  },
}

function inferMediaType(mimeType: string): MediaMessageType {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return 'file'
}

export class CallSignaling {
  private socket: WebSocket | null = null

  connect(sessionId: string, onSignal: (payload: CallSignalPayload) => void) {
    this.socket = new WebSocket(`${getCallWsUrl()}/calls/ws/${encodeURIComponent(sessionId)}`)
    this.socket.onmessage = (event) => {
      try { onSignal(JSON.parse(event.data) as CallSignalPayload) } catch { onSignal({ type: 'raw', message: String(event.data) }) }
    }
    return this.socket
  }

  send(payload: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('通话信令尚未连接')
    this.socket.send(JSON.stringify(payload))
  }

  disconnect() {
    this.socket?.close()
    this.socket = null
  }
}
