import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject, ReactNode } from 'react'
import {
  Check, ChevronDown, ContactRound, FileText, Image, Info, LogOut, Menu,
  MessageSquare, Mic, Minus, MoreVertical, Paperclip, Phone, Plus, Search, Send,
  Settings, Smile, UserPlus, Users, Video, Volume2, Wifi, WifiOff, X,
} from 'lucide-react'
import type { Room } from 'livekit-client'
import './App.css'
import { CallSignaling, api, getApiBaseUrl, getCallBaseUrl, getCallWsUrl, getChatGatewayUrl, getMediaBaseUrl } from './api'
import { decodeDeliveredAck, decodeErrorResponse, decodeRealtimeDelivery, decodeSendAck, extractTextFromDecodedPayload, toHistoryDelivery } from './chatProtocol'
import { Avatar, EmptyState, Logo, Modal } from './components'
import { conversations as seedConversations, friendRequests, initialMessages } from './data'
import type { BackendFriend, BackendFriendRequest, BackendGroup, BackendGroupJoinRequest, BackendHistoryItem, CallSession, ChatGatewayContent, ChatGatewayDelivery, ChatGatewayError, ChatGatewaySendAck, ChatMessage, Conversation, EntityId, FriendRequest, IncomingCall, MediaUpload, Session } from './types'

type Section = 'chats' | 'contacts' | 'groups' | 'requests' | 'settings'

const avatarPalette = ['#607be8', '#7b69d9', '#3a9d89', '#d48758', '#cf6f9f', '#4f9cd8']

// 把自己发过的消息 msgId 持久化到 localStorage。重启客户端后仍然能识别历史消息里
// "这条是我发的"。每个用户单独一个 key，避免登出登入不同账号时混淆。
function sentMsgIdsStorageKey(sessionId: string): string {
  return `mochat.sentMsgIds.${sessionId}`
}

function loadSentMsgIds(sessionId: string): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(sentMsgIdsStorageKey(sessionId))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((item) => typeof item === 'string' || typeof item === 'number').map(String))
  } catch {
    return new Set()
  }
}

function saveSentMsgIds(sessionId: string, ids: Set<string>): void {
  if (typeof localStorage === 'undefined') return
  try {
    const arr = Array.from(ids).slice(-2000) // 最多保留最近 2000 条，避免 localStorage 过大
    localStorage.setItem(sentMsgIdsStorageKey(sessionId), JSON.stringify(arr))
  } catch {
    // localStorage 满了或被禁用就静默忽略
  }
}

function initialsFor(name: string) {
  return (name.trim().slice(0, 1) || '?').toUpperCase()
}

function colorFor(id: EntityId) {
  const value = String(id).split('').reduce((sum, char) => sum + char.charCodeAt(0), 0)
  return avatarPalette[value % avatarPalette.length]
}

function friendToConversation(friend: BackendFriend): Conversation {
  const name = friend.username || `用户 ${friend.userId}`
  return {
    id: friend.conversationId,
    targetId: friend.userId,
    kind: 'private',
    name,
    initials: initialsFor(name),
    color: colorFor(friend.userId),
    preview: '暂无消息',
    time: '',
    unread: 0,
    online: false,
  }
}

function groupToConversation(group: BackendGroup): Conversation {
  const name = group.name || `群组 ${group.groupId}`
  return {
    id: group.groupId,
    targetId: group.groupId,
    kind: 'group',
    name,
    initials: initialsFor(name),
    color: colorFor(group.groupId),
    preview: '暂无消息',
    time: '',
    unread: 0,
    ownerUserId: group.ownerUserId,
  }
}

function groupJoinRequestToViewModel(request: BackendGroupJoinRequest): FriendRequest {
  return {
    id: request.requestId,
    name: `用户 ${request.fromUserId}`,
    userId: request.fromUserId,
    message: request.sign || '申请加入群聊',
    status: request.status === 'accepted' ? 'accepted' : request.status === 'rejected' ? 'rejected' : 'pending',
  }
}

function messageTime(serverTimeMs: number) {
  return new Date(serverTimeMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function decodeCiphertext(ciphertext: unknown): string {
  if (!ciphertext) return ''
  if (typeof ciphertext === 'string') {
    const bytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  }
  if (ciphertext instanceof Uint8Array || ciphertext instanceof ArrayBuffer) {
    return new TextDecoder().decode(ciphertext)
  }
  if (typeof ciphertext === 'object' && ciphertext !== null) {
    const obj = ciphertext as Record<string, number>
    const keys = Object.keys(obj)
    if (keys.length > 0 && keys.every((k) => !Number.isNaN(Number(k)))) {
      const bytes = new Uint8Array(keys.length)
      for (let i = 0; i < keys.length; i++) bytes[i] = obj[String(i)]
      return new TextDecoder().decode(bytes)
    }
  }
  return String(ciphertext)
}

function extractText(contents: ChatGatewayContent[] | undefined) {
  for (const content of contents ?? []) {
    if (content.plainText?.text) return content.plainText.text
    if (content.encryptedText?.ciphertext) {
      try {
        return decodeCiphertext(content.encryptedText.ciphertext)
      } catch {
        return '[加密消息]'
      }
    }
    if (content.media) return content.media.previewText || content.media.fileName || '[媒体消息]'
  }
  return ''
}

function mediaFields(contents: ChatGatewayContent[] | undefined) {
  const media = contents?.find((item) => item.media)?.media
  if (!media) return {}
  return {
    mediaUrl: media.mediaUrl,
    fileName: media.fileName,
  }
}

function deliveryToChatMessage(message: ChatGatewayDelivery, session: Session, fallbackFromMe = false): ChatMessage {
  const fields = mediaFields(message.contents)
  if (fields.mediaUrl) console.log('[MoChat] media message mediaUrl:', fields.mediaUrl, 'resolved:', resolveMediaUrl(fields.mediaUrl))
  return {
    id: message.msgId,
    seq: message.seq,
    conversationId: message.conversationId,
    fromMe: fallbackFromMe || String(message.fromUid) === String(session.userId),
    text: extractText(message.contents),
    time: messageTime(Number(message.serverTimeMs)),
    status: 'sent',
    ...fields,
  }
}

async function sendMediaMessage(
  session: Session,
  conversation: Conversation,
  media: MediaUpload,
  upsertConversationMessage: (message: ChatMessage) => void,
  pendingMessagesRef: MutableRefObject<Map<string, { conversationId: EntityId; text: string; mediaUrl?: string; fileName?: string }>>,
) {
  const clientMsgId = Date.now() + Math.floor(Math.random() * 1000)
  const optimisticMessage: ChatMessage = {
    id: `pending-media-${clientMsgId}`,
    clientMsgId,
    conversationId: conversation.id,
    fromMe: true,
    text: media.fileName || '[媒体消息]',
    time: messageTime(Date.now()),
    status: 'sending',
    mediaUrl: media.mediaUrl,
    fileName: media.fileName,
  }
  pendingMessagesRef.current.set(String(clientMsgId), {
    conversationId: conversation.id,
    text: optimisticMessage.text,
    mediaUrl: media.mediaUrl,
    fileName: media.fileName,
  })
  upsertConversationMessage(optimisticMessage)
  const payload = {
    sessionId: session.sessionId,
    clientMsgId,
    conversationId: conversation.id,
    media: {
      messageType: inferMediaKind(media.mimeType),
      mediaUrl: media.mediaUrl,
      thumbnailUrl: media.thumbnailUrl,
      fileSize: media.fileSize,
      mimeType: media.mimeType,
      fileName: media.fileName,
      previewText: media.fileName,
      waveformData: media.waveformData,
    },
  }
  if (conversation.kind === 'group') {
    await window.mochatDesktop?.chat.sendGroupMedia({ ...payload, groupId: conversation.targetId })
    return
  }
  await window.mochatDesktop?.chat.sendPrivateMedia({ ...payload, toUid: conversation.targetId })
}

function inferMediaKind(mimeType: string) {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return 'file'
}

function resolveMediaUrl(url: string): string {
  if (!url) return url
  if (/^https?:\/\//.test(url)) return url
  let path = url.startsWith('/') ? url : `/${url}`
  path = path.replace(/^\/media\/download/, '')
  return `https://img.lystran.com${path}`
}

function CdnImage({ src, alt, className, onClick }: { src: string; alt: string; className?: string; onClick?: () => void }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(src)
        if (cancelled) return
        if (!res.ok) { setError(`HTTP ${res.status}`); return }
        const blob = await res.blob()
        if (cancelled) return
        setBlobUrl(URL.createObjectURL(blob))
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'fetch failed')
      }
    }
    load()
    return () => { cancelled = true }
  }, [src])
  useEffect(() => { return () => { if (blobUrl) URL.revokeObjectURL(blobUrl) } }, [blobUrl])
  if (error) return <span className="message-image-error">[图片加载失败] {src} ({error})</span>
  if (!blobUrl) return <span className="message-image-loading">加载中...</span>
  return <img src={blobUrl} alt={alt} className={className} onClick={onClick} />
}

function friendRequestToViewModel(request: BackendFriendRequest): FriendRequest {
  return {
    id: request.requestId,
    name: `用户 ${request.fromUserId}`,
    userId: request.fromUserId,
    message: request.sign || '请求添加你为好友',
    status: request.status === 'cancelled' ? 'rejected' : request.status,
  }
}

function WindowControls() {
  if (!window.mochatDesktop || window.mochatDesktop.platform === 'darwin') return null
  return <div className="window-controls">
    <button onClick={window.mochatDesktop.window.minimize}><Minus /></button>
    <button onClick={window.mochatDesktop.window.maximize}>□</button>
    <button className="close" onClick={window.mochatDesktop.window.close}><X /></button>
  </div>
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setBusy(true)
    setError('')
    try {
      const session = await api.login(username.trim())
      localStorage.setItem('mochat.session', JSON.stringify(session))
      onLogin(session)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return <main className="login-screen">
    <WindowControls />
    <div className="login-orb orb-one" /><div className="login-orb orb-two" />
    <section className="login-card">
      <Logo />
      <h1>欢迎使用 MoChat</h1>
      <p>高吞吐多媒体即时通讯平台</p>
      <label htmlFor="username">用户名</label>
      <input id="username" value={username} onChange={(event) => setUsername(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && username.trim() && setConfirm(true)} placeholder="请输入用户名" autoFocus />
      {error && <div className="login-error">{error}</div>}
      <button className="primary-button full" disabled={!username.trim() || busy} onClick={() => setConfirm(true)}>登录 / 注册</button>
      <div className="secure-note"><Info />首次登录将自动生成身份公钥，用于端到端加密</div>
    </section>
    {confirm && <Modal title="创建或登录账号" onClose={() => setConfirm(false)} footer={<><button className="ghost-button" onClick={() => setConfirm(false)}>取消</button><button className="primary-button" disabled={busy} onClick={submit}>{busy ? '正在连接…' : '确认并进入'}</button></>}>
      <p>系统会为 <strong>{username.trim()}</strong> 生成或复用本地身份公钥。若后端当前不可用，将进入演示模式；若登录状态失效，需要重新登录。</p>
    </Modal>}
  </main>
}

function Sidebar({ section, setSection, session, onLogout }: { section: Section; setSection: (section: Section) => void; session: Session; onLogout: () => void }) {
  const [showProfile, setShowProfile] = useState(false)
  const nav: { id: Section; label: string; icon: typeof MessageSquare; badge?: number }[] = [
    { id: 'chats', label: '消息', icon: MessageSquare, badge: session.demo ? 2 : undefined },
    { id: 'contacts', label: '联系人', icon: ContactRound },
    { id: 'groups', label: '群组', icon: Users },
    { id: 'requests', label: '新的朋友', icon: UserPlus, badge: session.demo ? 2 : undefined },
  ]
  return <aside className="rail">
    <div className="drag-region" />
    <button className="profile-button" title={session.username} onClick={() => setShowProfile(true)}><Avatar initials={session.username.slice(0, 1).toUpperCase()} color="#607be8" size="sm" /></button>
    <nav>{nav.map(({ id, label, icon: Icon, badge }) => <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)} title={label}><Icon />{badge ? <span>{badge}</span> : null}</button>)}</nav>
    <div className="rail-bottom">
      <button className={section === 'settings' ? 'active' : ''} onClick={() => setSection('settings')} title="设置"><Settings /></button>
      <button onClick={onLogout} title="退出登录"><LogOut /></button>
    </div>
    {showProfile && <Modal title="我的账号" onClose={() => setShowProfile(false)} footer={<button className="ghost-button" onClick={() => setShowProfile(false)}>关闭</button>}>
      <div className="modal-form">
        <div className="account-row">
          <Avatar initials={session.username.slice(0, 1).toUpperCase()} color="#607be8" size="lg" />
          <div>
            <strong>{session.username}</strong>
            <span>用户 ID：{session.userId}</span>
            <em>{session.demo ? '演示模式' : '已连接服务'}</em>
          </div>
        </div>
      </div>
    </Modal>}
  </aside>
}

function ConversationList({ items, selected, onSelect }: { items: Conversation[]; selected: EntityId | null; onSelect: (id: EntityId) => void }) {
  const [query, setQuery] = useState('')
  const filtered = items.filter((item) => `${item.name}${item.preview}`.toLowerCase().includes(query.toLowerCase()))
  return <aside className="conversation-panel">
    <div className="drag-region panel-drag" />
    <div className="search-row"><div className="search-box"><Search /><input aria-label="搜索会话" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索联系人、群聊、消息" /></div><button className="add-button" title="新建会话"><Plus /></button></div>
    <div className="panel-heading"><span>最近消息</span><button><Menu /></button></div>
    <div className="conversation-list">{filtered.length === 0 ? <div className="conversation-empty">后端当前没有返回会话数据</div> : filtered.map((item) => <button key={item.id} className={`conversation-item ${selected === item.id ? 'active' : ''}`} onClick={() => onSelect(item.id)}>
      <Avatar initials={item.initials} color={item.color} online={item.online} />
      <span className="conversation-copy"><strong>{item.name}</strong><small>{item.preview}</small></span>
      <span className="conversation-meta"><time>{item.time}</time>{item.unread > 0 && <b>{item.unread}</b>}</span>
    </button>)}</div>
  </aside>
}

function Chat({
  conversation,
  messages,
  serviceMode,
  onSend,
  onCall,
  onDetails,
}: {
  conversation: Conversation
  messages: ChatMessage[]
  serviceMode: boolean
  onSend: (text: string, attachments: File[]) => Promise<void>
  onCall: (kind: 'voice' | 'video') => void
  onDetails: () => void
}) {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<File[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const current = messages.filter((message) => message.conversationId === conversation.id)
  function handlePaste(event: React.ClipboardEvent) {
    const items = event.clipboardData?.items
    if (!items) return
    const imageFiles: File[] = []
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }
    if (imageFiles.length > 0) {
      event.preventDefault()
      setAttachments((prev) => [...prev, ...imageFiles])
    }
  }
  async function send() {
    const files = attachments
    if (!draft.trim() && !files.length) return
    if (sending) return
    setSending(true)
    setError('')
    try {
      await onSend(draft.trim(), files)
      setDraft('')
      setAttachments([])
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '发送失败')
    } finally {
      setSending(false)
    }
  }
  return <section className="chat-panel">
    <header className="chat-header"><div className="chat-person"><Avatar initials={conversation.initials} color={conversation.color} size="sm" online={conversation.online} /><span><strong>{conversation.name}</strong><small>{conversation.kind === 'group' ? '群组会话' : serviceMode ? '已连接' : conversation.online ? '在线' : '离线'}</small></span></div><div className="chat-actions"><button onClick={() => onCall('voice')} title="语音通话"><Phone /></button><button onClick={() => onCall('video')} title="视频通话"><Video /></button><button onClick={onDetails} title="会话详情"><MoreVertical /></button></div></header>
    <div className="message-area">
      <div className="date-divider"><span>今天</span></div>
      {current.length === 0 ? <EmptyState icon={<MessageSquare />} title="开始聊天" text={`向 ${conversation.name} 发送第一条消息`} /> : current.map((message) => <div key={message.id} className={`message-row ${message.fromMe ? 'mine' : ''}`}>
        {!message.fromMe && <Avatar initials={conversation.initials} color={conversation.color} size="sm" />}
        <div><div className="message-bubble">{message.mediaUrl ? <CdnImage src={resolveMediaUrl(message.mediaUrl)} alt={message.fileName || '图片'} className="message-image" onClick={() => window.open(resolveMediaUrl(message.mediaUrl!), '_blank')} /> : message.text}</div><div className="message-time">{message.time}{message.fromMe && message.status === 'read' && <><Check /><Check /></>}</div></div>
      </div>)}
    </div>
    <footer className="composer">
      {attachments.length > 0 && <div className="attachment-preview">{attachments.some((f) => f.type.startsWith('image/')) ? attachments.filter((f) => f.type.startsWith('image/')).map((f, i) => <img key={i} src={URL.createObjectURL(f)} alt={f.name} className="attachment-thumb" />) : <><FileText /><span>{attachments.map((file) => file.name).join('、')}</span></>}<button onClick={() => setAttachments([])}><X /></button></div>}
      {error && <div className="composer-error">{error}</div>}
      <input ref={fileInputRef} className="file-picker" type="file" multiple onChange={(event) => setAttachments(Array.from(event.target.files ?? []))} />
      <div className="composer-tools"><button title="表情"><Smile /></button><button title="选择图片" onClick={() => fileInputRef.current?.click()}><Image /></button><button title="添加附件" onClick={() => fileInputRef.current?.click()}><Paperclip /></button><button title="语音消息"><Mic /></button></div>
      <textarea aria-label="消息" value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={handlePaste} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } }} placeholder="输入消息，Enter 发送，Shift + Enter 换行" />
      <button className="send-button" disabled={sending || (!draft.trim() && !attachments.length)} onClick={send}><Send /><span>{sending ? '发送中' : '发送'}</span></button>
    </footer>
  </section>
}

function ConversationDetailsModal({
  session,
  conversation,
  contacts,
  onClose,
  onRefreshDirectory,
}: {
  session: Session
  conversation: Conversation
  contacts: Conversation[]
  onClose: () => void
  onRefreshDirectory: () => Promise<void>
}) {
  const [memberUserId, setMemberUserId] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const isOwner = conversation.kind === 'group' && String(conversation.ownerUserId) === String(session.userId)

  async function inviteMember() {
    const targetUserId = memberUserId.trim()
    if (!targetUserId) {
      setError('请选择或输入要拉入群的用户 ID')
      return
    }
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await api.inviteGroupMember(session.sessionId, conversation.targetId, targetUserId)
      setMessage('已拉入群聊')
      setMemberUserId('')
      await onRefreshDirectory()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '拉人入群失败')
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={conversation.kind === 'group' ? '群聊详情' : '个人详情'} onClose={onClose} footer={<button className="ghost-button" disabled={busy} onClick={onClose}>关闭</button>}>
    <div className="details-panel">
      <div className="details-hero">
        <Avatar initials={conversation.initials} color={conversation.color} size="lg" online={conversation.online} />
        <div><strong>{conversation.name}</strong><span>{conversation.kind === 'group' ? `群 ID：${conversation.targetId}` : `用户 ID：${conversation.targetId}`}</span>{conversation.kind === 'group' && <small>群主：{conversation.ownerUserId}</small>}</div>
      </div>
      {conversation.kind === 'group' ? <div className="details-section">
        <h3>拉好友入群</h3>
        {isOwner ? <>
          <label>选择好友<select value={memberUserId} onChange={(event) => setMemberUserId(event.target.value)}><option value="">选择一个联系人</option>{contacts.map((contact) => <option key={String(contact.targetId)} value={String(contact.targetId)}>{contact.name}（{contact.targetId}）</option>)}</select></label>
          <label>或输入用户 ID<input value={memberUserId} onChange={(event) => setMemberUserId(event.target.value)} placeholder="输入好友用户 ID" /></label>
          {message && <div className="form-success">{message}</div>}
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button" disabled={busy} onClick={inviteMember}>{busy ? '拉人中…' : '拉入群聊'}</button>
        </> : <p>当前只有群主可以拉好友入群。</p>}
        <p className="muted-note">成员列表接口后端还没提供，这里先展示基础信息和拉人能力。</p>
      </div> : <div className="details-section"><h3>联系人信息</h3><p>会话 ID：{conversation.id}</p><p>状态：{conversation.online ? '在线' : '离线/未知'}</p></div>}
    </div>
  </Modal>
}

function Directory({
  section,
  session,
  conversations,
  onRefreshDirectory,
  onOpenConversation,
}: {
  section: Exclude<Section, 'chats'>
  session: Session
  conversations: Conversation[]
  onRefreshDirectory: () => Promise<void>
  onOpenConversation: (conversationId: EntityId) => void
}) {
  const [requests, setRequests] = useState<FriendRequest[]>(session.demo ? friendRequests : [])
  const [server, setServer] = useState(getApiBaseUrl())
  const [chatGateway, setChatGateway] = useState(getChatGatewayUrl())
  const [callServer, setCallServer] = useState(getCallBaseUrl())
  const [callWs, setCallWs] = useState(getCallWsUrl())
  const [mediaServer, setMediaServer] = useState(getMediaBaseUrl())
  const [notifications, setNotifications] = useState(true)
  const [dialog, setDialog] = useState<'friend' | 'group' | 'joinGroup' | 'groupRequests' | null>(null)
  const [friendUserId, setFriendUserId] = useState('')
  const [friendSign, setFriendSign] = useState('你好，我想添加你为好友')
  const [groupName, setGroupName] = useState('')
  const [joinGroupId, setJoinGroupId] = useState('')
  const [joinGroupSign, setJoinGroupSign] = useState('你好，我想加入群聊')
  const [manageGroup, setManageGroup] = useState<Conversation | null>(null)
  const [groupJoinRequests, setGroupJoinRequests] = useState<FriendRequest[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (session.demo || section !== 'requests') return
    let cancelled = false
    async function loadRequests() {
      setError('')
      try {
        const response = await api.receivedFriendRequests(session.sessionId)
        if (!cancelled) setRequests((response.requests ?? []).map(friendRequestToViewModel))
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '加载好友申请失败')
      }
    }
    loadRequests()
    return () => {
      cancelled = true
    }
  }, [section, session.demo, session.sessionId])

  // 每次切到「联系人」/「群组」tab 时重新拉一次通讯录，
  // 这样在一个机器开多个客户端的场景下，另一端的好友/群组变更能即时反映出来。
  // onRefreshDirectory 用 ref 持有，避免父组件传入新箭头函数引用导致 effect 反复触发。
  const refreshDirectoryRef = useRef(onRefreshDirectory)
  useEffect(() => {
    refreshDirectoryRef.current = onRefreshDirectory
  })
  useEffect(() => {
    if (session.demo) return
    if (section !== 'contacts' && section !== 'groups') return
    refreshDirectoryRef.current().catch((reason) => {
      console.warn('MoChat directory refresh on tab switch failed', reason)
    })
  }, [section, session.demo])

  async function submitFriendRequest() {
    const toUserId = friendUserId.trim()
    if (!/^\d+$/.test(toUserId)) {
      setError('请输入正确的用户 ID')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api.sendFriendRequest(session.sessionId, toUserId, friendSign.trim())
      setDialog(null)
      setFriendUserId('')
      setFriendSign('你好，我想添加你为好友')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '发送好友申请失败')
    } finally {
      setBusy(false)
    }
  }

  async function submitGroup() {
    const name = groupName.trim()
    if (!name) {
      setError('请输入群组名称')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api.createGroup(session.sessionId, name)
      setDialog(null)
      setGroupName('')
      await onRefreshDirectory()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建群组失败')
    } finally {
      setBusy(false)
    }
  }

  async function submitJoinGroup() {
    const groupId = joinGroupId.trim()
    if (!/^\d+$/.test(groupId)) {
      setError('请输入正确的群 ID')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api.sendGroupJoinRequest(session.sessionId, groupId, joinGroupSign.trim())
      setDialog(null)
      setJoinGroupId('')
      setJoinGroupSign('你好，我想加入群聊')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '发送入群申请失败')
    } finally {
      setBusy(false)
    }
  }

  async function openGroupRequests(group: Conversation) {
    setManageGroup(group)
    setDialog('groupRequests')
    setError('')
    setBusy(true)
    try {
      const response = await api.groupJoinRequests(session.sessionId, group.targetId)
      setGroupJoinRequests((response.requests ?? []).map(groupJoinRequestToViewModel))
    } catch (reason) {
      setGroupJoinRequests([])
      setError(reason instanceof Error ? reason.message : '加载入群申请失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleGroupJoinRequest(requestId: EntityId, action: 'accept' | 'reject') {
    if (!manageGroup) return
    setBusy(true)
    setError('')
    try {
      const response = await api.handleGroupJoinRequest(session.sessionId, manageGroup.targetId, requestId, action)
      setGroupJoinRequests((current) => current.map((item) => item.id === requestId ? groupJoinRequestToViewModel(response.request) : item))
      if (action === 'accept') await onRefreshDirectory()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '处理入群申请失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleRequest(requestId: EntityId, action: 'accept' | 'reject') {
    if (session.demo) {
      setRequests((current) => current.map((item) => item.id === requestId ? { ...item, status: action === 'accept' ? 'accepted' : 'rejected' } : item))
      return
    }
    setBusy(true)
    setError('')
    try {
      const response = await api.handleFriendRequest(session.sessionId, requestId, action)
      setRequests((current) => current.map((item) => item.id === requestId ? friendRequestToViewModel(response.request) : item))
      if (action === 'accept') await onRefreshDirectory()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '处理好友申请失败')
    } finally {
      setBusy(false)
    }
  }

  function closeDialog() {
    if (busy) return
    setDialog(null)
    setManageGroup(null)
    setError('')
  }

  if (section === 'settings') return <section className="page-panel">
    <header><h1>设置</h1><p>管理客户端偏好与服务连接</p></header>
    <div className="settings-card">
      <h3>账号</h3>
      <div className="account-row"><Avatar initials={session.username[0]} color="#607be8" size="lg" /><div><strong>{session.username}</strong><span>用户 ID：{session.userId}</span><em>{session.demo ? '演示模式' : '已连接服务'}</em></div></div>
    </div>
    <div className="settings-card">
      <h3>连接</h3>
      <label>API 服务地址<input value={server} onChange={(event) => setServer(event.target.value)} /></label>
      <label>聊天网关地址<input value={chatGateway} onChange={(event) => setChatGateway(event.target.value)} placeholder="tls://localhost:9000" /></label>
      <label>Call 服务地址<input value={callServer} onChange={(event) => setCallServer(event.target.value)} /></label>
      <label>Call WebSocket 地址<input value={callWs} onChange={(event) => setCallWs(event.target.value)} /></label>
      <label>Media 服务地址<input value={mediaServer} onChange={(event) => setMediaServer(event.target.value)} /></label>
      <button className="primary-button" onClick={() => { localStorage.setItem('mochat.server', server); localStorage.setItem('mochat.chatGateway', chatGateway); localStorage.setItem('mochat.callServer', callServer); localStorage.setItem('mochat.callWs', callWs); localStorage.setItem('mochat.mediaServer', mediaServer) }}>保存配置</button>
    </div>
    <div className="settings-card toggle-row"><div><h3>桌面通知</h3><p>收到新消息时显示系统通知</p></div><button className={`toggle ${notifications ? 'on' : ''}`} onClick={() => setNotifications(!notifications)}><i /></button></div>
  </section>
  if (section === 'requests') return <section className="page-panel"><header><h1>新的朋友</h1><p>{requests.filter((item) => item.status === 'pending').length} 个待处理申请</p></header>{error && <div className="page-error">{error}</div>}<div className="directory-list">{requests.length === 0 ? <EmptyState icon={<UserPlus />} title="暂无好友申请" text="收到新的好友申请后会显示在这里" /> : requests.map((request) => <div className="request-row" key={request.id}><Avatar initials={request.name[0]} color={colorFor(request.userId)} /><div><strong>{request.name}</strong><span>{request.message}</span><small>用户 ID：{request.userId}</small></div>{request.status === 'pending' ? <div className="request-actions"><button disabled={busy} onClick={() => handleRequest(request.id, 'reject')}>忽略</button><button className="primary-button" disabled={busy} onClick={() => handleRequest(request.id, 'accept')}>接受</button></div> : <em>{request.status === 'accepted' ? '已添加' : '已忽略'}</em>}</div>)}</div></section>
  const isGroup = section === 'groups'
  const source = conversations.filter((item) => isGroup ? item.kind === 'group' : item.kind === 'private')
  return <section className="page-panel"><header><div><h1>{isGroup ? '群组' : '联系人'}</h1><p>{source.length} {isGroup ? '个群聊' : '位联系人'}</p></div><div className="header-actions">{isGroup && <button className="ghost-button" onClick={() => { setError(''); setDialog('joinGroup') }}><UserPlus />加入群聊</button>}<button className="primary-button" onClick={() => { setError(''); setDialog(isGroup ? 'group' : 'friend') }}><Plus />{isGroup ? '创建群组' : '添加好友'}</button></div></header>{error && <div className="page-error">{error}</div>}<div className="directory-list">{source.length === 0 ? <EmptyState icon={isGroup ? <Users /> : <ContactRound />} title={isGroup ? '暂无群组' : '暂无联系人'} text={session.demo ? '演示数据为空' : '后端当前没有返回数据'} /> : source.map((item) => <div className="directory-row" key={item.id}><Avatar initials={item.initials} color={item.color} online={item.online} /><div><strong>{item.name}</strong><span>{isGroup ? `${item.targetId} · 群组` : `用户 ID：${item.targetId}`}</span></div><button className="ghost-button" onClick={() => onOpenConversation(item.id)}><MessageSquare />发消息</button>{isGroup && String(item.ownerUserId) === String(session.userId) ? <button className="ghost-button" onClick={() => openGroupRequests(item)}><UserPlus />入群申请</button> : <button className="icon-button"><MoreVertical /></button>}</div>)}</div>{dialog === 'friend' && <Modal title="添加好友" onClose={closeDialog} footer={<><button className="ghost-button" disabled={busy} onClick={closeDialog}>取消</button><button className="primary-button" disabled={busy} onClick={submitFriendRequest}>{busy ? '发送中…' : '发送申请'}</button></>}>
    <div className="modal-form">
      <label>用户 ID<input value={friendUserId} onChange={(event) => setFriendUserId(event.target.value)} placeholder="输入对方用户 ID" autoFocus /></label>
      <label>验证消息<input value={friendSign} onChange={(event) => setFriendSign(event.target.value)} placeholder="给对方看的备注" /></label>
      {error && <div className="form-error">{error}</div>}
    </div>
  </Modal>}{dialog === 'group' && <Modal title="创建群组" onClose={closeDialog} footer={<><button className="ghost-button" disabled={busy} onClick={closeDialog}>取消</button><button className="primary-button" disabled={busy} onClick={submitGroup}>{busy ? '创建中…' : '创建'}</button></>}>
    <div className="modal-form">
      <label>群组名称<input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="例如：项目联调群" autoFocus /></label>
      {error && <div className="form-error">{error}</div>}
    </div>
  </Modal>}{dialog === 'joinGroup' && <Modal title="加入群聊" onClose={closeDialog} footer={<><button className="ghost-button" disabled={busy} onClick={closeDialog}>取消</button><button className="primary-button" disabled={busy} onClick={submitJoinGroup}>{busy ? '发送中…' : '发送申请'}</button></>}>
    <div className="modal-form">
      <label>群 ID<input value={joinGroupId} onChange={(event) => setJoinGroupId(event.target.value)} placeholder="输入要加入的群 ID" autoFocus /></label>
      <label>验证消息<input value={joinGroupSign} onChange={(event) => setJoinGroupSign(event.target.value)} placeholder="给群主看的备注" /></label>
      {error && <div className="form-error">{error}</div>}
    </div>
  </Modal>}{dialog === 'groupRequests' && <Modal title={`${manageGroup?.name ?? '群聊'} · 入群申请`} onClose={closeDialog} footer={<button className="ghost-button" disabled={busy} onClick={closeDialog}>关闭</button>}>
    <div className="modal-form">
      {error && <div className="form-error">{error}</div>}
      {groupJoinRequests.length === 0 ? <p>暂无待处理入群申请</p> : groupJoinRequests.map((request) => <div className="request-row" key={request.id}><Avatar initials={request.name[0]} color={colorFor(request.userId)} /><div><strong>{request.name}</strong><span>{request.message}</span><small>用户 ID：{request.userId}</small></div>{request.status === 'pending' ? <div className="request-actions"><button disabled={busy} onClick={() => handleGroupJoinRequest(request.id, 'reject')}>拒绝</button><button className="primary-button" disabled={busy} onClick={() => handleGroupJoinRequest(request.id, 'accept')}>接受</button></div> : <em>{request.status === 'accepted' ? '已通过' : '已拒绝'}</em>}</div>)}
    </div>
  </Modal>}</section>
}

type CallVideoTargets = {
  local?: HTMLElement | null
  remote?: HTMLElement | null
}

async function acquireLocalMedia(kind: 'voice' | 'video'): Promise<MediaStream> {
  const constraints: MediaStreamConstraints = { audio: true }
  if (kind === 'video') constraints.video = { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
  try {
    return await navigator.mediaDevices.getUserMedia(constraints)
  } catch (e) {
    if (kind === 'video') {
      console.warn('[MoChat] video acquisition failed, falling back to audio-only', e)
      return navigator.mediaDevices.getUserMedia({ audio: true })
    }
    throw e
  }
}

function stopLocalMedia(stream: MediaStream | null) {
  if (!stream) return
  for (const track of stream.getTracks()) track.stop()
}

async function connectLiveKitRoom(result: Pick<CallSession, 'token' | 'livekitUrl'>, kind: 'voice' | 'video', videoTargets: CallVideoTargets = {}, localStream?: MediaStream | null) {
  if (!result.token || !result.livekitUrl) throw new Error('通话令牌未返回')
  let Room: any, RoomEvent: any, Track: any
  try {
    const lk = await import('livekit-client')
    Room = lk.Room; RoomEvent = lk.RoomEvent; Track = lk.Track
  } catch (e) {
    throw new Error('LiveKit 客户端加载失败')
  }
  const livekitRoom = new Room()
  const remoteAudioElements = new Set<HTMLMediaElement>()
  const videoElements = new Set<HTMLMediaElement>()
  type AttachableTrack = { kind: string; attach: () => HTMLMediaElement; detach: () => HTMLMediaElement[] }
  const attachRemoteAudio = (track: AttachableTrack) => {
    if (track.kind !== Track.Kind.Audio) return
    const element = track.attach() as HTMLAudioElement
    element.autoplay = true
    element.style.display = 'none'
    document.body.appendChild(element)
    remoteAudioElements.add(element)
    element.play().catch((reason: unknown) => console.warn('MoChat remote audio playback blocked', reason))
  }
  const attachVideo = (track: AttachableTrack, container?: HTMLElement | null) => {
    if (track.kind !== Track.Kind.Video || !container) return
    container.replaceChildren()
    const element = track.attach() as HTMLVideoElement
    element.autoplay = true
    element.muted = container === videoTargets.local
    element.playsInline = true
    element.style.width = '100%'
    element.style.height = '100%'
    element.style.objectFit = 'cover'
    container.appendChild(element)
    videoElements.add(element)
    element.play().catch((reason: unknown) => console.warn('MoChat video playback blocked', reason))
  }
  const detachTrack = (track: AttachableTrack) => {
    for (const element of track.detach()) {
      remoteAudioElements.delete(element)
      videoElements.delete(element)
      element.remove()
    }
  }
  const removeAllMedia = () => {
    for (const element of remoteAudioElements) element.remove()
    remoteAudioElements.clear()
    for (const element of videoElements) element.remove()
    videoElements.clear()
    videoTargets.local?.replaceChildren()
    videoTargets.remote?.replaceChildren()
  }
  livekitRoom.on(RoomEvent.TrackSubscribed, (track: AttachableTrack) => {
    try { attachRemoteAudio(track); attachVideo(track, videoTargets.remote) } catch (e) { console.warn('[MoChat] track subscribe error', e) }
  })
  livekitRoom.on(RoomEvent.TrackUnsubscribed, (track: AttachableTrack) => {
    try { detachTrack(track) } catch (e) { console.warn('[MoChat] track unsubscribe error', e) }
  })
  livekitRoom.on(RoomEvent.Disconnected, removeAllMedia)
  let rejectConnect: ((reason: Error) => void) | null = null
  const disconnectedPromise = new Promise<never>((_, reject) => {
    rejectConnect = reject
  })
  const onDisconnectedForConnect = () => {
    rejectConnect?.(new Error('LiveKit 房间已断开'))
  }
  livekitRoom.on(RoomEvent.Disconnected, onDisconnectedForConnect)
  const timeoutMs = 15000
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`LiveKit 连接超时（${Math.round(timeoutMs / 1000)} 秒），请检查服务地址或网络`)),
      timeoutMs,
    )
  })
  try {
    await Promise.race([
      livekitRoom.connect(result.livekitUrl, result.token),
      disconnectedPromise,
      timeoutPromise,
    ])
  } finally {
    livekitRoom.off(RoomEvent.Disconnected, onDisconnectedForConnect)
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
  if (localStream) {
    stopLocalMedia(localStream)
  }
  await livekitRoom.startAudio().catch((reason: unknown) => console.warn('MoChat audio playback start failed', reason))
  for (const participant of livekitRoom.remoteParticipants.values()) {
    for (const publication of participant.audioTrackPublications.values()) {
      if (publication.track) attachRemoteAudio(publication.track)
    }
    for (const publication of participant.videoTrackPublications.values()) {
      if (publication.track) attachVideo(publication.track, videoTargets.remote)
    }
  }
  await livekitRoom.localParticipant.setMicrophoneEnabled(true).catch((e: unknown) => console.warn('[MoChat] mic enable failed', e))
  if (kind === 'video') {
    await livekitRoom.localParticipant.setCameraEnabled(true).catch((e: unknown) => console.warn('[MoChat] camera enable failed', e))
    // Attach local camera track to local video container
    for (const publication of livekitRoom.localParticipant.videoTrackPublications.values()) {
      if (publication.track) attachVideo(publication.track, videoTargets.local)
    }
  }
  return livekitRoom
}

class CallErrorBoundary extends Component<{ onClose: () => void; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: Error) { return { error: error.message || '通话组件异常' } }
  componentDidCatch(error: Error) { console.error('[MoChat] call component crashed', error) }
  render() {
    if (this.state.error) return <div className="call-backdrop"><section className="call-card"><h2>通话异常</h2><p style={{ color: '#ff9ba4', margin: '16px 0' }}>{this.state.error}</p><div className="call-buttons"><button className="primary-button" onClick={this.props.onClose}>关闭</button></div></section></div>
    return this.props.children
  }
}

function useLocalPreview(stream: MediaStream | null, containerRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const container = containerRef.current
    if (!stream || !container) return
    const video = document.createElement('video')
    video.autoplay = true
    video.muted = true
    video.playsInline = true
    video.style.width = '100%'
    video.style.height = '100%'
    video.style.objectFit = 'cover'
    video.srcObject = stream
    container.replaceChildren(video)
    return () => {
      video.srcObject = null
      if (container.contains(video)) container.removeChild(video)
    }
  }, [stream, containerRef])
}

function CallModal({ session, conversation, kind, onClose }: { session: Session; conversation: Conversation; kind: 'voice' | 'video'; onClose: () => void }) {
  const [status, setStatus] = useState('正在获取摄像头/麦克风…')
  const [callSession, setCallSession] = useState<CallSession | null>(null)
  const [room, setRoom] = useState<Room | null>(null)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const localVideoRef = useRef<HTMLDivElement | null>(null)
  const remoteVideoRef = useRef<HTMLDivElement | null>(null)
  useLocalPreview(!room ? localStream : null, localVideoRef)

  useEffect(() => {
    let cancelled = false
    let activeRoom: Room | null = null
    let stream: MediaStream | null = null
    async function startCall() {
      try {
        try {
          stream = await acquireLocalMedia(kind)
        } catch (mediaError) {
          console.warn('[MoChat] media acquisition failed, falling back to audio-only', mediaError)
          stream = await acquireLocalMedia('voice')
        }
        if (cancelled) { stopLocalMedia(stream); return }
        setLocalStream(stream)
        setStatus('正在请求通话服务…')
        const result = conversation.kind === 'group'
          ? await api.startGroupCall(session.sessionId, conversation.targetId, kind)
          : await api.startPrivateCall(session.sessionId, conversation.targetId, kind)
        if (cancelled) return
        setCallSession(result)
        if (!result.token || !result.livekitUrl) {
          setStatus('通话邀请已发送，等待对方上线或接听')
          return
        }
        setStatus('正在连接 LiveKit 房间…')
        const livekitRoom = await connectLiveKitRoom(result, kind, { local: localVideoRef.current, remote: remoteVideoRef.current }, stream)
        stream = null
        activeRoom = livekitRoom
        if (cancelled) {
          livekitRoom.disconnect()
          return
        }
        setRoom(livekitRoom)
        setStatus(kind === 'video' ? '视频通话已连接' : '语音通话已连接')
      } catch (reason) {
        setStatus(reason instanceof Error ? reason.message : '通话服务连接失败')
      }
    }
    startCall()
    return () => {
      cancelled = true
      stopLocalMedia(stream)
      activeRoom?.disconnect()
    }
  }, [conversation.kind, conversation.targetId, kind, session.sessionId])

  async function hangup() {
    stopLocalMedia(localStream)
    if (callSession?.roomName && conversation.kind === 'group') {
      await api.leaveGroupCall(session.sessionId, callSession.roomName).catch(() => undefined)
    }
    room?.disconnect()
    onClose()
  }

  return <div className="call-backdrop"><section className={`call-card ${kind === 'video' ? 'video-call-card' : ''}`}>
    <div className="call-video-stage" style={{ display: kind === 'video' ? undefined : 'none' }}><div className="call-video-remote" ref={remoteVideoRef} /><div className="call-video-local" ref={localVideoRef} /></div>
    {kind !== 'video' && <div className="call-pulse"><Avatar initials={conversation.initials} color={conversation.color} size="lg" /></div>}
    <h2>{conversation.name}</h2><p>{kind === 'video' ? '正在发起视频通话…' : '正在发起语音通话…'}</p><div className="call-status"><Wifi />{status}</div>{callSession?.roomName && <div className="call-room">房间：{callSession.roomName}</div>}<div className="call-buttons"><button title="扬声器"><Volume2 /></button><button title="麦克风"><Mic /></button><button className="hangup" onClick={hangup} title="挂断"><Phone /></button></div>
  </section></div>
}

function IncomingCallModal({
  session,
  incoming,
  connectedSession,
  signaling,
  onConnectedConsumed,
  onClose,
}: {
  session: Session
  incoming: IncomingCall
  connectedSession: CallSession | null
  signaling: CallSignaling
  onConnectedConsumed: () => void
  onClose: () => void
}) {
  const [status, setStatus] = useState('收到通话邀请')
  const [room, setRoom] = useState<Room | null>(null)
  const [accepting, setAccepting] = useState(false)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [chosenKind, setChosenKind] = useState<'voice' | 'video'>(incoming.callKind || 'voice')
  const localVideoRef = useRef<HTMLDivElement | null>(null)
  const remoteVideoRef = useRef<HTMLDivElement | null>(null)
  const onConnectedConsumedRef = useRef(onConnectedConsumed)
  const mountedRef = useRef(true)
  useLocalPreview(!room ? localStream : null, localVideoRef)
  useEffect(() => {
    onConnectedConsumedRef.current = onConnectedConsumed
  })
  useEffect(() => () => { mountedRef.current = false }, [])

  useEffect(() => {
    if (!connectedSession || connectedSession.roomName !== incoming.roomName || room) return
    const sessionToConnect = connectedSession
    let cancelled = false
    let stream: MediaStream | null = null
    async function connectAcceptedPrivateCall() {
      try {
        try {
          stream = await acquireLocalMedia(chosenKind)
        } catch (mediaError) {
          console.warn('[MoChat] media acquisition failed, falling back to audio-only', mediaError)
          stream = await acquireLocalMedia('voice')
        }
        if (cancelled) { stopLocalMedia(stream); return }
        setLocalStream(stream)
        setStatus('正在连接 LiveKit 房间…')
        const livekitRoom = await connectLiveKitRoom(sessionToConnect, chosenKind, { local: localVideoRef.current, remote: remoteVideoRef.current }, stream)
        stream = null
        if (cancelled || !mountedRef.current) {
          livekitRoom.disconnect()
          return
        }
        setRoom(livekitRoom)
        setStatus(chosenKind === 'video' ? '视频通话已连接' : '语音通话已连接')
        onConnectedConsumedRef.current()
      } catch (reason) {
        if (mountedRef.current) setStatus(reason instanceof Error ? reason.message : '通话服务连接失败')
      }
    }
    connectAcceptedPrivateCall()
    return () => {
      cancelled = true
      stopLocalMedia(stream)
    }
  }, [chosenKind, connectedSession, incoming.roomName, room])

  async function accept(kind: 'voice' | 'video') {
    setAccepting(true)
    setChosenKind(kind)
    setStatus('正在接听…')
    try {
      let stream: MediaStream | null = null
      try {
        stream = await acquireLocalMedia(kind)
      } catch (mediaError) {
        console.warn('[MoChat] media acquisition failed on accept, trying audio-only', mediaError)
        stream = await acquireLocalMedia('voice')
      }
      if (!mountedRef.current) { stopLocalMedia(stream); return }
      setLocalStream(stream)
      if (incoming.type === 'call_group_started') {
        const result = await api.joinGroupCall(session.sessionId, incoming.roomName)
        if (!mountedRef.current) { stopLocalMedia(stream); return }
        setStatus('正在连接 LiveKit 房间…')
        const livekitRoom = await connectLiveKitRoom(result, kind, { local: localVideoRef.current, remote: remoteVideoRef.current }, stream)
        if (!mountedRef.current) { livekitRoom.disconnect(); return }
        setRoom(livekitRoom)
        setStatus(kind === 'video' ? '视频通话已连接' : '语音通话已连接')
        return
      }
      signaling.send({
        fromUserId: session.userId,
        toUserId: incoming.fromUserId,
        type: 'call_accept',
        roomName: incoming.roomName,
      })
      setStatus('已发送接听信令，等待对方房间信息…')
    } catch (reason) {
      if (mountedRef.current) {
        setStatus(reason instanceof Error ? reason.message : '接听失败')
        setAccepting(false)
      }
    }
  }

  async function close() {
    stopLocalMedia(localStream)
    if (room && incoming.type === 'call_group_started') {
      await api.leaveGroupCall(session.sessionId, incoming.roomName).catch(() => undefined)
    }
    room?.disconnect()
    onClose()
  }

  const showVideo = chosenKind === 'video' && accepting
  return <div className="call-backdrop"><section className={`call-card ${showVideo ? 'video-call-card' : ''}`}>
    <div className="call-video-stage" style={{ display: showVideo ? undefined : 'none' }}><div className="call-video-remote" ref={remoteVideoRef} /><div className="call-video-local" ref={localVideoRef} /></div>
    {!showVideo && <div className="call-pulse"><Avatar initials={incoming.type === 'call_group_started' ? '群' : '来'} color="#d48758" size="lg" /></div>}
    <h2>{incoming.type === 'call_group_started' ? `群聊 ${incoming.groupId}` : `用户 ${incoming.fromUserId}`}</h2><p>{accepting ? (chosenKind === 'video' ? '视频通话中' : '语音通话中') : '邀请你进行通话'}</p><div className="call-status"><Wifi />{status}</div><div className="call-room">房间：{incoming.roomName}</div><div className="call-buttons">{!room && !accepting && <><button className="primary-button" onClick={() => accept('voice')} title="语音接听"><Phone /></button><button className="primary-button" onClick={() => accept('video')} title="视频接听"><Video /></button></>}<button className="hangup" onClick={close} title={room ? '挂断' : '拒绝'}><Phone /></button></div>
  </section></div>
}

function MainApp({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [section, setSection] = useState<Section>('chats')
  const [conversations, setConversations] = useState<Conversation[]>(session.demo ? seedConversations : [])
  const [selected, setSelected] = useState<EntityId | null>(session.demo ? seedConversations[0]?.id ?? null : null)
  const [messages, setMessages] = useState<ChatMessage[]>(session.demo ? initialMessages : [])
  const [chatStatus, setChatStatus] = useState<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>(session.demo ? 'disconnected' : 'connecting')
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [directoryError, setDirectoryError] = useState('')
  const [call, setCall] = useState<'voice' | 'video' | null>(null)
  const [detailsConversation, setDetailsConversation] = useState<Conversation | null>(null)
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null)
  const [connectedIncomingCall, setConnectedIncomingCall] = useState<CallSession | null>(null)
  const [callSignalStatus, setCallSignalStatus] = useState<'connecting' | 'ready' | 'disconnected'>(session.demo ? 'disconnected' : 'connecting')
  const latestSeqRef = useRef(new Map<string, number>())
  const pendingMessagesRef = useRef(new Map<string, { conversationId: EntityId; text: string; mediaUrl?: string; fileName?: string }>())
  // 自己发过的消息 msgId 集合，作为 fromMe 判定的兜底：
  // 历史接口虽然已返回 senderUid（toHistoryDelivery 会写入 fromUid），
  // 但为了兼容服务端 senderUid 缺/为 0 的旧数据，以及实时消息尚未收齐前先渲染本地消息，
  // 仍把 SEND_ACK 拿到的 msgId 记下来，渲染历史时查这个集合就能正确判断 fromMe。
  // 持久化到 localStorage，客户端重启后仍能识别。
  const sentMsgIdsRef = useRef<Set<string>>(loadSentMsgIds(session.sessionId))
  const selectedConversation = useMemo(() => conversations.find((item) => item.id === selected) ?? null, [conversations, selected])
  const signaling = useMemo(() => new CallSignaling(), [])
  const refreshConversationPreview = useCallback((conversationId: EntityId, latest?: ChatMessage) => {
    if (!latest) return
    setConversations((current) => current.map((conversation) => String(conversation.id) === String(conversationId)
      ? { ...conversation, preview: latest.text, time: latest.time }
      : conversation
    ))
  }, [])
  const upsertConversationMessage = useCallback((message: ChatMessage) => {
    setMessages((current) => {
      const conversationMessages = current.filter((item) => String(item.conversationId) === String(message.conversationId))
      const others = current.filter((item) => String(item.conversationId) !== String(message.conversationId))
      const nextConversation = [...conversationMessages.filter((item) => String(item.id) !== String(message.id) && String(item.clientMsgId) !== String(message.clientMsgId)), message]
        .sort((left, right) => Number(left.seq ?? left.id) - Number(right.seq ?? right.id))
      return [...others, ...nextConversation]
    })
    refreshConversationPreview(message.conversationId, message)
  }, [refreshConversationPreview])
  const loadMessages = useCallback(async () => {
    if (session.demo || !selectedConversation) return
    // 整个加载流程用 try/catch 兜底：任何一条消息解码失败、网络异常都不会让
    // UI 一直停在"没消息"的状态。已成功解码的消息会先塞进 state，再继续处理剩下的。
    try {
      const response = await api.history(session.sessionId, selectedConversation.id)
      const remoteMessages: ChatMessage[] = []
      for (const item of response.items ?? []) {
        try {
          const historyItem: BackendHistoryItem = {
            ...item,
            conversationId: selectedConversation.id,
          }
          const delivery = toHistoryDelivery(historyItem, selectedConversation.kind)
          // fromMe 判断（不依赖后端 senderUid 字段，纯粹用本地信息推）：
          // 1) 自己在本次会话发过的消息，msgId 会被记在 sentMsgIdsRef 集合里（来自 SEND_ACK）；
          // 2) 私聊消息可以通过 payload 解码出来的 toUid 反推——"接收者 == 我"意味着是对方发的；
          // 3) 群聊没有 toUid 字段，退回 fromUid 判定（实时 delivery 会写入 fromUid）。
          const knownSent = item.msgId !== undefined && sentMsgIdsRef.current.has(String(item.msgId))
          const toUid = (delivery as { toUid?: EntityId }).toUid
          const privateFromMe = selectedConversation.kind === 'private'
            && !knownSent
            && typeof toUid !== 'undefined'
            && String(toUid) !== '0'
            && String(toUid) !== String(session.userId)
          const message = deliveryToChatMessage(delivery, session, knownSent || privateFromMe)
          const text = selectedConversation.kind === 'private'
            ? extractTextFromDecodedPayload({ contents: delivery.contents as unknown[] })
            : message.text
          remoteMessages.push({ ...message, text })
        } catch (itemError) {
          // 单条消息解析失败：用原始数据塞一条占位消息进 state，不让整个列表消失
          console.warn('MoChat history item decode failed', itemError, item)
          remoteMessages.push({
            id: item.msgId,
            seq: item.seq,
            conversationId: selectedConversation.id,
            fromMe: false,
            text: '[消息内容无法解析]',
            time: messageTime(Number(item.serverTimeMs) || Date.now()),
            status: 'sent',
          })
        }
      }
      if (remoteMessages.length > 0) {
        remoteMessages.sort((a, b) => Number(a.seq ?? a.id) - Number(b.seq ?? b.id))
        latestSeqRef.current.set(String(selectedConversation.id), Number(remoteMessages.at(-1)?.seq ?? 0))
        setMessages((current) => {
          const otherMessages = current.filter((message) => String(message.conversationId) !== String(selectedConversation.id))
          return [...otherMessages, ...remoteMessages]
        })
        refreshConversationPreview(selectedConversation.id, remoteMessages.at(-1))
      }
    } catch (error) {
      console.warn('MoChat history load failed', error)
      // 不 throw，让 UI 至少保留之前已展示的消息
    }
    // 触发一次 RECEIVE_ACK（不依赖 await 成功）— 即使历史接口报错，
    // 也得保证 access-gateway.SessionBindingHandler 有机会 bind 上。
    await window.mochatDesktop?.chat.sendReceiveAck({
      sessionId: session.sessionId,
      conversationId: selectedConversation.id,
      latestReceivedSeq: latestSeqRef.current.get(String(selectedConversation.id)) ?? 0,
    }).catch(() => undefined)
  }, [refreshConversationPreview, selectedConversation, session])
  const loadDirectory = useCallback(async (cancelled?: () => boolean) => {
    setDirectoryLoading(true)
    setDirectoryError('')
    try {
      const [friendsResponse, groupsResponse] = await Promise.all([
        api.friends(session.sessionId),
        api.groups(session.sessionId),
      ])
      if (cancelled?.()) return
      const remoteConversations = [
        ...(friendsResponse.friends ?? []).map(friendToConversation),
        ...(groupsResponse.groups ?? []).map(groupToConversation),
      ]
      setConversations(remoteConversations)
      setSelected((current) => remoteConversations.some((item) => item.id === current) ? current : remoteConversations[0]?.id ?? null)
      setMessages([])
    } catch (reason) {
      if (cancelled?.()) return
      setConversations([])
      setSelected(null)
      setMessages([])
      setDirectoryError(reason instanceof Error ? reason.message : '加载通讯录失败')
    } finally {
      if (!cancelled?.()) setDirectoryLoading(false)
    }
  }, [session.sessionId])
  useEffect(() => {
    if (session.demo) return
    let cancelled = false
    Promise.resolve().then(() => loadDirectory(() => cancelled))
    return () => {
      cancelled = true
    }
  }, [loadDirectory, session.demo])
  useEffect(() => {
    console.log('[MainApp] chat effect:', { demo: session.demo, hasChat: !!window.mochatDesktop?.chat, gatewayUrl: getChatGatewayUrl() })
    if (session.demo || !window.mochatDesktop?.chat) { console.warn('[MainApp] chat effect skipped: demo=', session.demo, 'hasChat=', !!window.mochatDesktop?.chat); return }
    setChatStatus('connecting')
    window.mochatDesktop.chat.connect({ gatewayUrl: getChatGatewayUrl() }).catch((reason) => {
      console.warn('MoChat chat gateway connect failed', reason)
      setChatStatus('disconnected')
    })
    const unsubscribe = window.mochatDesktop.chat.onEvent((event) => {
      const type = typeof event.type === 'string' ? event.type : ''
      if (type === 'state') {
        const state = String(event.state || 'disconnected')
        if (state === 'connected' || state === 'reconnecting' || state === 'connecting' || state === 'disconnected') {
          setChatStatus(state)
        }
        return
      }
      if (type === 'send-ack') {
        const ack = decodeSendAck(event.payload) as ChatGatewaySendAck
        const pending = pendingMessagesRef.current.get(String(ack.clientMsgId))
        if (!pending) return
        pendingMessagesRef.current.delete(String(ack.clientMsgId))
        const message: ChatMessage = {
          id: ack.msgId,
          clientMsgId: ack.clientMsgId,
          seq: ack.seq,
          conversationId: pending.conversationId,
          fromMe: true,
          text: pending.text,
          time: messageTime(Number(ack.serverTimeMs)),
          status: 'sent',
          mediaUrl: pending.mediaUrl,
          fileName: pending.fileName,
        }
        latestSeqRef.current.set(String(pending.conversationId), Number(ack.seq))
        // 把 msgId 记到 sentMsgIds 里，渲染历史时用这个判断 fromMe
        sentMsgIdsRef.current.add(String(ack.msgId))
        saveSentMsgIds(session.sessionId, sentMsgIdsRef.current)
        upsertConversationMessage(message)
        return
      }
      if (type === 'delivery') {
        const delivery = decodeRealtimeDelivery(event.payload)
        const chatMessage = deliveryToChatMessage(delivery, session)
        latestSeqRef.current.set(String(chatMessage.conversationId), Number(delivery.seq))
        upsertConversationMessage(chatMessage)
        window.mochatDesktop?.chat.sendReceiveAck({
          sessionId: session.sessionId,
          conversationId: delivery.conversationId,
          latestReceivedSeq: delivery.seq,
        }).catch(() => undefined)
        return
      }
      if (type === 'delivered-ack') {
        decodeDeliveredAck(event.payload)
        return
      }
      if (type === 'error-response') {
        const error = decodeErrorResponse(event.payload) as ChatGatewayError
        if (error.errorCode === 1000 || error.errorCode === 1001) {
          window.dispatchEvent(new CustomEvent('mochat:session-invalid', { detail: error.message }))
          return
        }
        setDirectoryError(error.message)
        return
      }
      if (type === 'socket-error' && typeof event.message === 'string') {
        setDirectoryError(event.message)
      }
    })
    return () => {
      unsubscribe()
      window.mochatDesktop?.chat.disconnect().catch(() => undefined)
    }
  }, [session, upsertConversationMessage])
  // 当前聊天对象变化、或 chat 网关连上后，主动发一条带 sessionId 的 RECEIVE_ACK。
  // access-gateway 的 SessionBindingHandler 只在收到 PRIVATE_MESSAGE / GROUP_MESSAGE / CLIENT_RECEIVE_ACK
  // 这类带 sessionId 的消息时才会去权威服务认人，并把 online:user:{uid} 写进 Redis。
  // 如果不发，access-gateway 永远找不到这条连接来推实时消息。
  // 这里除了"变化时立即发"，还额外加一个 5s 间隔的定时器反复发，确保
  // 即使对端 access-gateway 重启导致 binding 丢失，客户端也能很快重新 bind 上。
  useEffect(() => {
    if (session.demo || chatStatus !== 'connected') return
    let stopped = false
    function send() {
      if (stopped) return
      const target = selectedConversation ?? null
      // 没选会话时也要发——SessionBindingHandler 在 access-gateway 上是按 userId 维度绑定的，
      // 跟具体会话无关。先发一个 convId=0 的 RECEIVE_ACK 触发 bind，之后会话切换时再发具体的。
      window.mochatDesktop?.chat.sendReceiveAck({
        sessionId: session.sessionId,
        conversationId: target?.id ?? '0',
        latestReceivedSeq: target ? latestSeqRef.current.get(String(target.id)) ?? 0 : 0,
      }).catch(() => undefined)
    }
    send()
    const interval = window.setInterval(send, 5000)
    return () => {
      stopped = true
      window.clearInterval(interval)
    }
  }, [chatStatus, selectedConversation, session])
  useEffect(() => {
    if (session.demo) return
    let disposed = false
    let retryCount = 0
    let retryTimer = 0
    let socket: WebSocket | null = null
    let readyReceived = false

    const connect = () => {
      if (disposed) return
      readyReceived = false
      setCallSignalStatus('connecting')
      socket = signaling.connect(session.sessionId, (payload) => {
        if (payload.type === 'call_signal_ready') {
          readyReceived = true
          retryCount = 0
          setCallSignalStatus('ready')
          return
        }
        if (payload.type === 'call_invite' && payload.fromUserId && payload.roomName) {
          setIncomingCall({ type: 'call_invite', callId: payload.callId, fromUserId: payload.fromUserId, roomName: payload.roomName, callKind: payload.callKind })
          return
        }
        if (payload.type === 'call_group_started' && payload.fromUserId && payload.groupId && payload.roomName) {
          setIncomingCall({ type: 'call_group_started', callId: payload.callId, fromUserId: payload.fromUserId, groupId: payload.groupId, roomName: payload.roomName, callKind: payload.callKind })
          return
        }
        if (payload.type === 'call_accepted_with_token' && payload.roomName && payload.token && payload.livekitUrl) {
          setConnectedIncomingCall({ roomName: payload.roomName, token: payload.token, livekitUrl: payload.livekitUrl })
          return
        }
        if (payload.type?.startsWith('call_')) console.info('MoChat call signal', payload)
      })
      socket.onerror = () => {
        console.warn('MoChat call signaling disconnected')
      }
      socket.onclose = (event) => {
        if (disposed) return
        if (!readyReceived) setCallSignalStatus('disconnected')
        if (event.code === 1008) {
          window.dispatchEvent(new CustomEvent('mochat:session-invalid', { detail: '通话信令登录状态已失效，请重新登录' }))
          return
        }
        const delay = Math.min(1000 * 2 ** retryCount, 8000)
        retryCount += 1
        setCallSignalStatus('connecting')
        retryTimer = window.setTimeout(connect, delay)
      }
    }

    connect()
    return () => {
      disposed = true
      window.clearTimeout(retryTimer)
      socket?.close()
      signaling.disconnect()
    }
  }, [session.demo, session.sessionId, signaling])
  useEffect(() => {
    if (session.demo || !selectedConversation) return
    loadMessages().catch((reason) => console.warn('MoChat history load failed', reason))
  }, [loadMessages, selectedConversation, session.demo])
  async function send(text: string, attachments: File[]) {
    if (!selectedConversation || selected === null) return
    const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    const optimisticId = Date.now()
    if (session.demo) {
      const localMessage = { id: optimisticId, conversationId: selected, fromMe: true, text, time: now, status: 'sent' } satisfies ChatMessage
      setMessages((current) => [...current, localMessage])
      refreshConversationPreview(selected, localMessage)
      return
    }
    const clientMsgId = Date.now()
    if (text.trim()) {
      const optimisticMessage = {
        id: `pending-${clientMsgId}`,
        clientMsgId,
        conversationId: selectedConversation.id,
        fromMe: true,
        text,
        time: now,
        status: 'sending',
      } satisfies ChatMessage
      pendingMessagesRef.current.set(String(clientMsgId), { conversationId: selectedConversation.id, text })
      upsertConversationMessage(optimisticMessage)
      if (selectedConversation.kind === 'group') {
        await window.mochatDesktop?.chat.sendGroupText({
          sessionId: session.sessionId,
          clientMsgId,
          conversationId: selectedConversation.id,
          groupId: selectedConversation.targetId,
          text,
        })
      } else {
        await window.mochatDesktop?.chat.sendPrivateText({
          sessionId: session.sessionId,
          clientMsgId,
          conversationId: selectedConversation.id,
          toUid: selectedConversation.targetId,
          text,
        })
      }
    }
    if (attachments.length > 0) {
      for (const file of attachments) {
        const media = await api.uploadMedia(file)
        await sendMediaMessage(session, selectedConversation, media, upsertConversationMessage, pendingMessagesRef)
      }
    }
  }
  return <main className="app-shell">
    <WindowControls />
    <Sidebar section={section} setSection={setSection} session={session} onLogout={onLogout} />
    {section === 'chats' ? <><ConversationList items={conversations} selected={selected} onSelect={setSelected} />{directoryLoading ? <section className="chat-panel"><EmptyState icon={<MessageSquare />} title="正在加载会话" text="正在从后端读取好友与群组" /></section> : selectedConversation ? <Chat conversation={selectedConversation} messages={messages} serviceMode={!session.demo} onSend={send} onCall={setCall} onDetails={() => setDetailsConversation(selectedConversation)} /> : <section className="chat-panel"><EmptyState icon={<MessageSquare />} title="暂无会话" text={directoryError || '后端当前没有返回好友或群组'} /></section>}</> : <Directory section={section} session={session} conversations={conversations} onRefreshDirectory={() => loadDirectory()} onOpenConversation={(conversationId) => { setSelected(conversationId); setSection('chats') }} />}
    <div className={`connection-pill ${session.demo || chatStatus !== 'connected' ? 'demo' : ''}`}>{session.demo || chatStatus !== 'connected' ? <WifiOff /> : <Wifi />}{session.demo ? '演示模式' : chatStatus === 'connected' ? (callSignalStatus === 'ready' ? '聊天与通话已连接' : '聊天已连接') : chatStatus === 'reconnecting' ? '聊天服务重连中' : chatStatus === 'connecting' ? '聊天服务连接中' : '聊天服务已断开'}<ChevronDown /></div>
    {call && selectedConversation && <CallErrorBoundary onClose={() => setCall(null)}><CallModal session={session} conversation={selectedConversation} kind={call} onClose={() => setCall(null)} /></CallErrorBoundary>}
    {detailsConversation && <ConversationDetailsModal session={session} conversation={detailsConversation} contacts={conversations.filter((item) => item.kind === 'private')} onRefreshDirectory={() => loadDirectory()} onClose={() => setDetailsConversation(null)} />}
    {incomingCall && <CallErrorBoundary onClose={() => { setIncomingCall(null); setConnectedIncomingCall(null) }}><IncomingCallModal session={session} incoming={incomingCall} connectedSession={connectedIncomingCall} signaling={signaling} onConnectedConsumed={() => setConnectedIncomingCall(null)} onClose={() => { setIncomingCall(null); setConnectedIncomingCall(null) }} /></CallErrorBoundary>}
  </main>
}

export default function App() {
  const [session, setSession] = useState<Session | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('mochat.session') || 'null') as Session | null
      return saved?.demo ? null : saved
    }
    catch { return null }
  })
  useEffect(() => {
    function handleSessionInvalid() {
      localStorage.removeItem('mochat.session')
      setSession(null)
    }
    window.addEventListener('mochat:session-invalid', handleSessionInvalid)
    return () => window.removeEventListener('mochat:session-invalid', handleSessionInvalid)
  }, [])
  function logout() { localStorage.removeItem('mochat.session'); setSession(null) }
  return session ? <MainApp session={session} onLogout={logout} /> : <Login onLogin={setSession} />
}
