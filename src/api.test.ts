import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, getApiBaseUrl, getCallBaseUrl, getCallWsUrl, getMediaBaseUrl } from './api'

describe('MoChat API client', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('uses the server saved in settings', () => {
    localStorage.setItem('mochat.server', 'https://chat.example.com/')
    expect(getApiBaseUrl()).toBe('https://chat.example.com')
  })

  it('uses split backend service URLs', () => {
    localStorage.setItem('mochat.callServer', 'http://localhost:8090/')
    localStorage.setItem('mochat.callWs', 'ws://localhost:8090/')
    localStorage.setItem('mochat.mediaServer', 'http://localhost:8083/')
    expect(getCallBaseUrl()).toBe('http://localhost:8090')
    expect(getCallWsUrl()).toBe('ws://localhost:8090')
    expect(getMediaBaseUrl()).toBe('http://localhost:8083')
  })

  it('falls back to a demo session when the backend is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ userId: 7, username: 'alice', sessionId: 'session-7' }),
    }))
    vi.spyOn(crypto.subtle, 'generateKey').mockRejectedValue(new Error('unavailable'))
    const session = await api.login('alice')
    expect(session.username).toBe('alice')
    expect(session.demo).toBe(true)
  })
})
