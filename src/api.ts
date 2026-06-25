import type {
  BackendFriend,
  BackendFriendRequest,
  BackendGroup,
  BackendGroupJoinRequest,
  BackendHistoryItem,
  CallSession,
  CallSignalPayload,
  Conversation,
  EntityId,
  MediaMessageType,
  MediaUpload,
  Session,
} from './types'

const demoEnabled = import.meta.env.VITE_DEMO_MODE === 'true'

// 服务器已经 seed 的用户列表：登录这些用户名时必须用 seed 里的 publicKey，
// 否则服务端 PostgreSQL 里已有的 X25519 公钥校验会拒绝（400 publicKey mismatch）。
// 其他用户名随机生成 32 字节身份密钥，让 loginOrRegister 路径自动开户。
const SEED_IDENTITY: Record<string, string> = {
  alice: 'kKLWF9BhKhM9Hpa8hHJ5GSwT1siclljWTfSXICzXglg=',
  bob: 'zRqkJgR0wYAE1KcZbFlNgdRmyrX6qjcE+mbdxESTyCI=',
  carol: 'AebyWTXbesZyM/84CZicekytA4r80ElO0gugdiLFxB8=',
  dave: 'LI3DiEPX+h4dDMKPnOjGA9oUNpqFN04oXdSKZkGe7VQ=',
  eve: 'MysFrPmPK5CfEeTj5f3xr8e+42ThZ5uWxftdoNq/3W4=',
}

function configuredValue(key: 'server' | 'callServer' | 'callWs' | 'mediaServer' | 'chatGateway', storageKey: string, fallback?: string) {
  return localStorage.getItem(storageKey) || window.mochatDesktop?.launchConfig?.[key] || fallback || ''
}

export function getApiBaseUrl() {
  return configuredValue('server', 'mochat.server', import.meta.env.VITE_API_BASE_URL || 'http://103.40.14.14:57675').replace(/\/$/, '')
}

export function getCallBaseUrl() {
  return configuredValue('callServer', 'mochat.callServer', import.meta.env.VITE_CALL_BASE_URL || 'http://103.40.14.14:24478').replace(/\/$/, '')
}

export function getCallWsUrl() {
  const configured = configuredValue('callWs', 'mochat.callWs', import.meta.env.VITE_CALL_WS_URL)
  return (configured || getCallBaseUrl().replace(/^http/, 'ws')).replace(/\/$/, '')
}

export function getMediaBaseUrl() {
  // multimedia-service 跟 api-service 同地址；（让 fallback 不再指向 localhost:8083）
  return configuredValue('mediaServer', 'mochat.mediaServer', import.meta.env.VITE_MEDIA_BASE_URL || getApiBaseUrl()).replace(/\/$/, '')
}

export function getChatGatewayUrl() {
  const configured = localStorage.getItem('mochat.chatGateway') || window.mochatDesktop?.launchConfig?.chatGateway || import.meta.env.VITE_CHAT_GATEWAY_URL
  if (configured) return normalizeChatGatewayUrl(configured)
  // 未配置时，从 api-service 地址推导：同主机、固定 TCP 端口 20823
  const api = new URL(getApiBaseUrl())
  const host = normalizeChatGatewayHost(api.hostname)
  return `tls://${host}:20823`
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
  // 服务器 seed 用户必须使用固定 publicKey，否则后端会拒绝
  if (SEED_IDENTITY[username]) {
    localStorage.setItem(`mochat.identityKey.${username}`, SEED_IDENTITY[username])
    return SEED_IDENTITY[username]
  }
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
      if (!(error instanceof TypeError)) throw error
      return { userId: 10001, username, sessionId: `demo-${crypto.randomUUID()}`, demo: true }
    }
  },
  friends: (sessionId: string) => apiRequest<{ friends?: BackendFriend[] }>(`/friends?sessionId=${encodeURIComponent(sessionId)}`),
  groups: (sessionId: string) => apiRequest<{ groups?: BackendGroup[] }>(`/groups?sessionId=${encodeURIComponent(sessionId)}`),
  history: (sessionId: string, conversationId: EntityId, opts: { cursorSeq?: EntityId; limit?: number } = {}) => {
    const params = new URLSearchParams({ sessionId, conversationId: String(conversationId), limit: String(opts.limit ?? 50) })
    if (opts.cursorSeq != null) params.set('cursorSeq', String(opts.cursorSeq))
    return apiRequest<{ items?: Omit<BackendHistoryItem, 'conversationId'>[] }>(`/history?${params.toString()}`)
  },
  conversationState: (sessionId: string, conversationId: EntityId) =>
    apiRequest<{ conversationId: EntityId; latestSeq: EntityId; latestMessageTime: number }>(`/conversations/${conversationId}/state?sessionId=${encodeURIComponent(sessionId)}`),
  privatePeerReceivedSeq: (sessionId: string, conversationId: EntityId) =>
    apiRequest<{ conversationId: EntityId; latestReceivedSeq: EntityId }>(`/conversations/${conversationId}/private-peer-received-seq?sessionId=${encodeURIComponent(sessionId)}`),
  createGroup: (sessionId: string, name: string) => apiRequest<{ group: BackendGroup }>('/groups', { method: 'POST', body: JSON.stringify({ sessionId, name }) }),
  // 后端没有 “拉人直接入群” 的 HTTP 接口，唯一的入群方式是 “申请加入 → 群主审批”。
  // 这个方法保留只是为了兼容旧的 UI 调用点，调用会得到 404，UI 层会引导改成 “邀请对方发送加群申请”。
  sendGroupJoinRequest: (sessionId: string, groupId: EntityId, sign = '') => apiRequest<{ request: BackendGroupJoinRequest }>(`/groups/${groupId}/join-requests`, { method: 'POST', body: JSON.stringify({ sessionId, sign }) }),
  groupJoinRequests: (sessionId: string, groupId: EntityId) => apiRequest<{ requests?: BackendGroupJoinRequest[] }>(`/groups/${groupId}/join-requests?sessionId=${encodeURIComponent(sessionId)}`),
  handleGroupJoinRequest: (sessionId: string, groupId: EntityId, requestId: EntityId, action: 'accept' | 'reject') => apiRequest<{ request: BackendGroupJoinRequest }>(`/groups/${groupId}/join-requests/${requestId}/handle`, { method: 'POST', body: JSON.stringify({ sessionId, action }) }),
  sendFriendRequest: (sessionId: string, toUserId: EntityId, sign = '') => apiRequest<{ request: BackendFriendRequest }>('/friends/requests', { method: 'POST', body: JSON.stringify({ sessionId, toUserId, sign }) }),
  receivedFriendRequests: (sessionId: string) => apiRequest<{ requests?: BackendFriendRequest[] }>(`/friends/requests/received?sessionId=${encodeURIComponent(sessionId)}`),
  handleFriendRequest: (sessionId: string, requestId: EntityId, action: 'accept' | 'reject') => apiRequest<{ request: BackendFriendRequest }>(`/friends/requests/${requestId}/handle`, { method: 'POST', body: JSON.stringify({ sessionId, action }) }),
  // 通话 HTTP 接口；callKind 字段后端忽略，统一走 voice 路径，token 入房后 LiveKit 自己升级 video。
  startPrivateCall: (sessionId: string, toUserId: EntityId) =>
    callRequest<CallSession>('/calls/private/invite', { method: 'POST', body: JSON.stringify({ sessionId, toUserId }) }),
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

// CallSignaling：与 call-service 的 WebSocket 信令通道。
// 私聊信令（call_accept / call_reject / call_cancel / call_hangup）通过 WebSocket 发送，
// 后端在 WebSocket onMessage 路径里转给 CallService.forwardPrivateSignal，
// 并在被叫发 call_accept 时回 call_accepted_with_token（包含被叫入房 token）。
export class CallSignaling {
  // 暴露 socket 字段，方便上层组件在已经复用 connect 监听 onSignal 之外，
  // 再用 addEventListener('message') 监听特定 type（如主叫监听被叫的 accept/reject/hangup）。
  socket: WebSocket | null = null

  connect(sessionId: string, onSignal: (payload: CallSignalPayload) => void) {
    this.socket = new WebSocket(`${getCallWsUrl()}/calls/ws/${encodeURIComponent(sessionId)}`)
    this.socket.onmessage = (event) => {
      try {
        onSignal(parseJsonPreservingLargeIntegers(String(event.data)) as unknown as CallSignalPayload)
      } catch {
        onSignal({ type: 'raw', message: String(event.data) })
      }
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