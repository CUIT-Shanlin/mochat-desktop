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
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const session = await api.login('alice')
    expect(session.username).toBe('alice')
    expect(session.demo).toBe(true)
  })

  it('does not fall back to demo mode for backend validation errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      text: () => Promise.resolve(JSON.stringify({ message: 'publicKey does not match persisted identity key' })),
    }))
    await expect(api.login('alice')).rejects.toThrow('publicKey does not match persisted identity key')
  })

  it('keeps a stable 32-byte identity key per username', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ userId: 7, username: 'alice', sessionId: 'session-7' })),
    })
    vi.stubGlobal('fetch', fetchMock)
    await api.login('alice')
    await api.login('alice')
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(firstBody.publicKey).toBe(secondBody.publicKey)
    expect(Uint8Array.from(atob(firstBody.publicKey), (char) => char.charCodeAt(0))).toHaveLength(32)
  })
})
