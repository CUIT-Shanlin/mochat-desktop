import type { BackendFriend, BackendFriendRequest, BackendGroup, BackendGroupJoinRequest, BackendHistoryItem, CallSession, CallSignalPayload, Conversation, EntityId, MediaMessageType, MediaUpload, Session } from './types'

const demoEnabled = import.meta.env.VITE_DEMO_MODE === 'true'
const testIdentityKeys: Record<string, string> = {
  dkh: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=',
  mochat_alice: 'egVLD9Zpd4lMjPqqrJAlz6SewBAtGsQetX5FMOryBYA=',
  mochat_bob: 'rz+yFQsoNPBC9L8bmGQSyyrsVYYsztR3zYeMVlkDBkU=',
  mochat_carol: '1EFmIYZ7LMN10Je/6qouv6sMY/SoiXVdK8QmcwFpHEw=',
}

function configuredValue(key: 'server' | 'callServer' | 'callWs' | 'mediaServer', storageKey: string, fallback?: string) {
  return localStorage.getItem(storageKey) || window.mochatDesktop?.launchConfig?.[key] || fallback || ''
}

export function getApiBaseUrl() {
  return configuredValue('server', 'mochat.server', import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080').replace(/\/$/, '')
}

export function getCallBaseUrl() {
  return configuredValue('callServer', 'mochat.callServer', import.meta.env.VITE_CALL_BASE_URL || 'http://localhost:8090').replace(/\/$/, '')
}

export function getCallWsUrl() {
  const configured = configuredValue('callWs', 'mochat.callWs', import.meta.env.VITE_CALL_WS_URL)
  return (configured || getCallBaseUrl().replace(/^http/, 'ws')).replace(/\/$/, '')
}

export function getMediaBaseUrl() {
  return configuredValue('mediaServer', 'mochat.mediaServer', import.meta.env.VITE_MEDIA_BASE_URL || 'http://localhost:8083').replace(/\/$/, '')
}

export function getChatGatewayUrl() {
  const configured = localStorage.getItem('mochat.chatGateway') || import.meta.env.VITE_CHAT_GATEWAY_URL
  if (configured) return normalizeChatGatewayUrl(configured)
  const api = new URL(getApiBaseUrl())
  const host = normalizeChatGatewayHost(api.hostname)
  return `tls://${host}:9000`
}

function normalizeChatGatewayUrl(raw: string) {
  const normalized = raw.replace(/\/$/, '')
  try {
    const url = new URL(normalized.includes('://') ? normalized : `tls://${normalized}`)
    url.hostname = normalizeChatGatewayHost(url.hostname)
    return url.toString().replace(/\/$/, '')
  } catch {
    return normalized
  }
}

function normalizeChatGatewayHost(hostname: string) {
  if (hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1' || hostname === '[::1]') {
    return 'localhost'
  }
  return hostname
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const text = await response.text().catch(() => '')
  const body = parseJsonPreservingLargeIntegers(text)
  const errorMessage = typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : `请求失败 (${response.status})`
  if (response.status === 401 || errorMessage.toLowerCase().includes('session invalid') || errorMessage.toLowerCase().includes('invalid session')) {
    const error = new SessionInvalidError(errorMessage)
    window.dispatchEvent(new CustomEvent('mochat:session-invalid', { detail: error.message }))
    throw error
  }
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
  if (testIdentityKeys[username]) {
    localStorage.setItem(storageKey, testIdentityKeys[username])
    return testIdentityKeys[username]
  }
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
      if (!(error instanceof TypeError)) throw error
      return { userId: 10001, username, sessionId: `demo-${crypto.randomUUID()}`, demo: true }
    }
  },
  friends: (sessionId: string) => apiRequest<{ friends?: BackendFriend[] }>(`/friends?sessionId=${encodeURIComponent(sessionId)}`),
  groups: (sessionId: string) => apiRequest<{ groups?: BackendGroup[] }>(`/groups?sessionId=${encodeURIComponent(sessionId)}`),
  history: (sessionId: string, conversationId: EntityId) =>
    apiRequest<{ items?: Omit<BackendHistoryItem, 'conversationId'>[] }>(`/history?sessionId=${encodeURIComponent(sessionId)}&conversationId=${conversationId}&limit=50`),
  conversationState: (sessionId: string, conversationId: EntityId) =>
    apiRequest<{ conversationId: EntityId; latestSeq: EntityId; latestMessageTime: number }>(`/conversations/${conversationId}/state?sessionId=${encodeURIComponent(sessionId)}`),
  privatePeerReceivedSeq: (sessionId: string, conversationId: EntityId) =>
    apiRequest<{ conversationId: EntityId; latestReceivedSeq: EntityId }>(`/conversations/${conversationId}/private-peer-received-seq?sessionId=${encodeURIComponent(sessionId)}`),
  createGroup: (sessionId: string, name: string) => apiRequest<{ group: BackendGroup }>('/groups', { method: 'POST', body: JSON.stringify({ sessionId, name }) }),
  inviteGroupMember: (sessionId: string, groupId: EntityId, memberUserId: EntityId) =>
    apiRequest<{ groupId: EntityId; userId: EntityId; status: string }>(`/groups/${groupId}/members`, { method: 'POST', body: JSON.stringify({ sessionId, memberUserId }) }),
  sendGroupJoinRequest: (sessionId: string, groupId: EntityId, sign = '') => apiRequest<{ request: BackendGroupJoinRequest }>(`/groups/${groupId}/join-requests`, { method: 'POST', body: JSON.stringify({ sessionId, sign }) }),
  groupJoinRequests: (sessionId: string, groupId: EntityId) => apiRequest<{ requests?: BackendGroupJoinRequest[] }>(`/groups/${groupId}/join-requests?sessionId=${encodeURIComponent(sessionId)}`),
  handleGroupJoinRequest: (sessionId: string, groupId: EntityId, requestId: EntityId, action: 'accept' | 'reject') => apiRequest<{ request: BackendGroupJoinRequest }>(`/groups/${groupId}/join-requests/${requestId}/handle`, { method: 'POST', body: JSON.stringify({ sessionId, action }) }),
  sendFriendRequest: (sessionId: string, toUserId: EntityId, sign = '') => apiRequest<{ request: BackendFriendRequest }>('/friends/requests', { method: 'POST', body: JSON.stringify({ sessionId, toUserId, sign }) }),
  receivedFriendRequests: (sessionId: string) => apiRequest<{ requests?: BackendFriendRequest[] }>(`/friends/requests/received?sessionId=${encodeURIComponent(sessionId)}`),
  handleFriendRequest: (sessionId: string, requestId: EntityId, action: 'accept' | 'reject') => apiRequest<{ request: BackendFriendRequest }>(`/friends/requests/${requestId}/handle`, { method: 'POST', body: JSON.stringify({ sessionId, action }) }),
  startPrivateCall: (sessionId: string, toUserId: EntityId, callKind: 'voice' | 'video' = 'voice') =>
    callRequest<CallSession>('/calls/private/invite', { method: 'POST', body: JSON.stringify({ sessionId, toUserId, callKind }) }),
  signalPrivateCall: (sessionId: string, toUserId: EntityId, type: 'call_accept' | 'call_reject' | 'call_hangup', roomName: string) =>
    callRequest<CallSession>('/calls/private/signal', { method: 'POST', body: JSON.stringify({ sessionId, toUserId, type, roomName }) }),
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
      try { onSignal(parseJsonPreservingLargeIntegers(String(event.data)) as unknown as CallSignalPayload) } catch { onSignal({ type: 'raw', message: String(event.data) }) }
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

export class SessionInvalidError extends Error {
  constructor(message = '登录状态已失效，请重新登录') {
    super(message)
    this.name = 'SessionInvalidError'
  }
}
