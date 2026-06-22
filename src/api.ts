import type { Session } from './types'

const demoEnabled = import.meta.env.VITE_DEMO_MODE !== 'false'

export function getApiBaseUrl() {
  return (localStorage.getItem('mochat.server') || import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080').replace(/\/$/, '')
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || body.message || `请求失败 (${response.status})`)
  return (body.data ?? body) as T
}

async function generatePublicKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])
  const bytes = await crypto.subtle.exportKey('spki', pair.publicKey)
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
}

export const api = {
  async login(username: string): Promise<Session> {
    try {
      const publicKey = await generatePublicKey()
      return await request<Session>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, publicKey }),
      })
    } catch (error) {
      if (!demoEnabled) throw error
      return { userId: 10001, username, sessionId: `demo-${crypto.randomUUID()}`, demo: true }
    }
  },
  friends: (sessionId: string) => request<{ friends: unknown[] }>(`/friends?sessionId=${encodeURIComponent(sessionId)}`),
  groups: (sessionId: string) => request<{ groups: unknown[] }>(`/groups?sessionId=${encodeURIComponent(sessionId)}`),
  history: (sessionId: string, conversationId: number) => request<{ items: unknown[] }>(`/history?sessionId=${encodeURIComponent(sessionId)}&conversationId=${conversationId}&limit=50`),
  createGroup: (sessionId: string, name: string) => request('/groups', { method: 'POST', body: JSON.stringify({ sessionId, name }) }),
  sendFriendRequest: (sessionId: string, toUserId: number) => request('/friends/requests', { method: 'POST', body: JSON.stringify({ sessionId, toUserId, sign: '' }) }),
}

export class CallSignaling {
  private socket: WebSocket | null = null

  connect(sessionId: string, onSignal: (payload: unknown) => void) {
    const configured = localStorage.getItem('mochat.callWs') || import.meta.env.VITE_CALL_WS_URL
    const origin = configured || getApiBaseUrl().replace(/^http/, 'ws')
    this.socket = new WebSocket(`${origin.replace(/\/$/, '')}/calls/ws/${encodeURIComponent(sessionId)}`)
    this.socket.onmessage = (event) => {
      try { onSignal(JSON.parse(event.data)) } catch { onSignal(event.data) }
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
