import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check, ChevronDown, ContactRound, FileText, Image, Info, LogOut, Menu,
  MessageSquare, Mic, Minus, MoreVertical, Paperclip, Phone, Plus, Search, Send,
  Settings, Smile, UserPlus, Users, Video, Volume2, Wifi, WifiOff, X,
} from 'lucide-react'
import type { Room } from 'livekit-client'
import './App.css'
import { CallSignaling, api, getApiBaseUrl, getCallBaseUrl, getCallWsUrl, getMediaBaseUrl } from './api'
import { Avatar, EmptyState, Logo, Modal } from './components'
import { conversations as seedConversations, friendRequests, initialMessages } from './data'
import type { BackendFriend, BackendFriendRequest, BackendGroup, BackendGroupJoinRequest, BackendTextMessage, CallSession, ChatMessage, Conversation, EntityId, FriendRequest, IncomingCall, Session } from './types'

type Section = 'chats' | 'contacts' | 'groups' | 'requests' | 'settings'

const avatarPalette = ['#607be8', '#7b69d9', '#3a9d89', '#d48758', '#cf6f9f', '#4f9cd8']

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

function textMessageToChatMessage(message: BackendTextMessage, session: Session): ChatMessage {
  return {
    id: message.msgId,
    conversationId: message.conversationId,
    fromMe: String(message.senderUserId) === String(session.userId),
    text: message.text,
    time: messageTime(message.serverTimeMs),
    status: 'sent',
  }
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
  const nav: { id: Section; label: string; icon: typeof MessageSquare; badge?: number }[] = [
    { id: 'chats', label: '消息', icon: MessageSquare, badge: session.demo ? 2 : undefined },
    { id: 'contacts', label: '联系人', icon: ContactRound },
    { id: 'groups', label: '群组', icon: Users },
    { id: 'requests', label: '新的朋友', icon: UserPlus, badge: session.demo ? 2 : undefined },
  ]
  return <aside className="rail">
    <div className="drag-region" />
    <button className="profile-button" title={session.username}><Avatar initials={session.username.slice(0, 1).toUpperCase()} color="#607be8" size="sm" /></button>
    <nav>{nav.map(({ id, label, icon: Icon, badge }) => <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)} title={label}><Icon />{badge ? <span>{badge}</span> : null}</button>)}</nav>
    <div className="rail-bottom">
      <button className={section === 'settings' ? 'active' : ''} onClick={() => setSection('settings')} title="设置"><Settings /></button>
      <button onClick={onLogout} title="退出登录"><LogOut /></button>
    </div>
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

function Chat({ conversation, messages, serviceMode, onSend, onCall }: { conversation: Conversation; messages: ChatMessage[]; serviceMode: boolean; onSend: (text: string, attachments: File[]) => Promise<void>; onCall: (kind: 'voice' | 'video') => void }) {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<File[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const current = messages.filter((message) => message.conversationId === conversation.id)
  async function send() {
    const files = attachments
    const text = draft.trim() || (files.length ? `附件：${files.map((file) => file.name).join('、')}` : '')
    if (!text || sending) return
    setSending(true)
    setError('')
    try {
      await onSend(text, files)
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
    <header className="chat-header"><div className="chat-person"><Avatar initials={conversation.initials} color={conversation.color} size="sm" online={conversation.online} /><span><strong>{conversation.name}</strong><small>{conversation.kind === 'group' ? '群组会话' : serviceMode ? '已连接' : conversation.online ? '在线' : '离线'}</small></span></div><div className="chat-actions"><button onClick={() => onCall('voice')} title="语音通话"><Phone /></button><button onClick={() => onCall('video')} title="视频通话"><Video /></button><button title="会话详情"><MoreVertical /></button></div></header>
    <div className="message-area">
      <div className="date-divider"><span>今天</span></div>
      {current.length === 0 ? <EmptyState icon={<MessageSquare />} title="开始聊天" text={`向 ${conversation.name} 发送第一条消息`} /> : current.map((message) => <div key={message.id} className={`message-row ${message.fromMe ? 'mine' : ''}`}>
        {!message.fromMe && <Avatar initials={conversation.initials} color={conversation.color} size="sm" />}
        <div><div className="message-bubble">{message.text}</div><div className="message-time">{message.time}{message.fromMe && message.status === 'read' && <><Check /><Check /></>}</div></div>
      </div>)}
    </div>
    <footer className="composer">
      {attachments.length > 0 && <div className="attachment-preview"><FileText /><span>{attachments.map((file) => file.name).join('、')}</span><button onClick={() => setAttachments([])}><X /></button></div>}
      {error && <div className="composer-error">{error}</div>}
      <input ref={fileInputRef} className="file-picker" type="file" multiple onChange={(event) => setAttachments(Array.from(event.target.files ?? []))} />
      <div className="composer-tools"><button title="表情"><Smile /></button><button title="选择图片" onClick={() => fileInputRef.current?.click()}><Image /></button><button title="添加附件" onClick={() => fileInputRef.current?.click()}><Paperclip /></button><button title="语音消息"><Mic /></button></div>
      <textarea aria-label="消息" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } }} placeholder="输入消息，Enter 发送，Shift + Enter 换行" />
      <button className="send-button" disabled={sending || (!draft.trim() && !attachments.length)} onClick={send}><Send /><span>{sending ? '发送中' : '发送'}</span></button>
    </footer>
  </section>
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

  if (section === 'settings') return <section className="page-panel"><header><h1>设置</h1><p>管理客户端偏好与服务连接</p></header><div className="settings-card"><h3>账号</h3><div className="account-row"><Avatar initials={session.username[0]} color="#607be8" size="lg" /><div><strong>{session.username}</strong><span>用户 ID：{session.userId}</span><em>{session.demo ? '演示模式' : '已连接服务'}</em></div></div></div><div className="settings-card"><h3>连接</h3><label>API 服务地址<input value={server} onChange={(event) => setServer(event.target.value)} /></label><label>Call 服务地址<input value={callServer} onChange={(event) => setCallServer(event.target.value)} /></label><label>Call WebSocket 地址<input value={callWs} onChange={(event) => setCallWs(event.target.value)} /></label><label>Media 服务地址<input value={mediaServer} onChange={(event) => setMediaServer(event.target.value)} /></label><button className="primary-button" onClick={() => { localStorage.setItem('mochat.server', server); localStorage.setItem('mochat.callServer', callServer); localStorage.setItem('mochat.callWs', callWs); localStorage.setItem('mochat.mediaServer', mediaServer) }}>保存配置</button></div><div className="settings-card toggle-row"><div><h3>桌面通知</h3><p>收到新消息时显示系统通知</p></div><button className={`toggle ${notifications ? 'on' : ''}`} onClick={() => setNotifications(!notifications)}><i /></button></div></section>
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

async function connectLiveKitRoom(result: Pick<CallSession, 'token' | 'livekitUrl'>, kind: 'voice' | 'video') {
  if (!result.token || !result.livekitUrl) throw new Error('通话令牌未返回')
  const { Room } = await import('livekit-client')
  const livekitRoom = new Room()
  await livekitRoom.connect(result.livekitUrl, result.token)
  await livekitRoom.localParticipant.setMicrophoneEnabled(true)
  if (kind === 'video') await livekitRoom.localParticipant.setCameraEnabled(true)
  return livekitRoom
}

function CallModal({ session, conversation, kind, onClose }: { session: Session; conversation: Conversation; kind: 'voice' | 'video'; onClose: () => void }) {
  const [status, setStatus] = useState('正在请求通话服务…')
  const [callSession, setCallSession] = useState<CallSession | null>(null)
  const [room, setRoom] = useState<Room | null>(null)

  useEffect(() => {
    let cancelled = false
    let activeRoom: Room | null = null
    async function startCall() {
      try {
        const result = conversation.kind === 'group'
          ? await api.startGroupCall(session.sessionId, conversation.targetId)
          : await api.startPrivateCall(session.sessionId, conversation.targetId)
        if (cancelled) return
        setCallSession(result)
        if (!result.token || !result.livekitUrl) {
          setStatus('通话邀请已发送，等待对方上线或接听')
          return
        }
        setStatus('正在连接 LiveKit 房间…')
        const livekitRoom = await connectLiveKitRoom(result, kind)
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
      activeRoom?.disconnect()
    }
  }, [conversation.kind, conversation.targetId, kind, session.sessionId])

  async function hangup() {
    if (callSession?.roomName && conversation.kind === 'group') {
      await api.leaveGroupCall(session.sessionId, callSession.roomName).catch(() => undefined)
    }
    room?.disconnect()
    onClose()
  }

  return <div className="call-backdrop"><section className="call-card"><div className="call-pulse"><Avatar initials={conversation.initials} color={conversation.color} size="lg" /></div><h2>{conversation.name}</h2><p>{kind === 'video' ? '正在发起视频通话…' : '正在发起语音通话…'}</p><div className="call-status"><Wifi />{status}</div>{callSession?.roomName && <div className="call-room">房间：{callSession.roomName}</div>}<div className="call-buttons"><button title="扬声器"><Volume2 /></button><button title="麦克风"><Mic /></button><button className="hangup" onClick={hangup} title="挂断"><Phone /></button></div></section></div>
}

function IncomingCallModal({
  session,
  incoming,
  signaling,
  connectedSession,
  onConnectedConsumed,
  onClose,
}: {
  session: Session
  incoming: IncomingCall
  signaling: CallSignaling
  connectedSession: CallSession | null
  onConnectedConsumed: () => void
  onClose: () => void
}) {
  const [status, setStatus] = useState('收到通话邀请')
  const [room, setRoom] = useState<Room | null>(null)
  const [accepting, setAccepting] = useState(false)

  useEffect(() => {
    if (!connectedSession || connectedSession.roomName !== incoming.roomName || room) return
    const sessionToConnect = connectedSession
    let cancelled = false
    async function connectAcceptedPrivateCall() {
      try {
        setStatus('正在连接 LiveKit 房间…')
        const livekitRoom = await connectLiveKitRoom(sessionToConnect, 'voice')
        if (cancelled) {
          livekitRoom.disconnect()
          return
        }
        setRoom(livekitRoom)
        setStatus('语音通话已连接')
        onConnectedConsumed()
      } catch (reason) {
        setStatus(reason instanceof Error ? reason.message : '通话服务连接失败')
      }
    }
    connectAcceptedPrivateCall()
    return () => {
      cancelled = true
    }
  }, [connectedSession, incoming.roomName, onConnectedConsumed, room])

  async function accept() {
    setAccepting(true)
    setStatus('正在接听…')
    try {
      if (incoming.type === 'call_group_started') {
        const result = await api.joinGroupCall(session.sessionId, incoming.roomName)
        setStatus('正在连接 LiveKit 房间…')
        const livekitRoom = await connectLiveKitRoom(result, 'voice')
        setRoom(livekitRoom)
        setStatus('语音通话已连接')
        return
      }
      signaling.send({
        fromUserId: session.userId,
        toUserId: incoming.fromUserId,
        type: 'call_accept',
        roomName: incoming.roomName,
      })
      setStatus('已接听，正在等待通话令牌…')
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : '接听失败')
      setAccepting(false)
    }
  }

  async function close() {
    if (room && incoming.type === 'call_group_started') {
      await api.leaveGroupCall(session.sessionId, incoming.roomName).catch(() => undefined)
    }
    room?.disconnect()
    onClose()
  }

  return <div className="call-backdrop"><section className="call-card"><div className="call-pulse"><Avatar initials={incoming.type === 'call_group_started' ? '群' : '来'} color="#d48758" size="lg" /></div><h2>{incoming.type === 'call_group_started' ? `群聊 ${incoming.groupId}` : `用户 ${incoming.fromUserId}`}</h2><p>邀请你进行语音通话</p><div className="call-status"><Wifi />{status}</div><div className="call-room">房间：{incoming.roomName}</div><div className="call-buttons">{!room && <button className="primary-button" disabled={accepting} onClick={accept} title="接听"><Phone /></button>}<button className="hangup" onClick={close} title={room ? '挂断' : '拒绝'}><Phone /></button></div></section></div>
}

function MainApp({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [section, setSection] = useState<Section>('chats')
  const [conversations, setConversations] = useState<Conversation[]>(session.demo ? seedConversations : [])
  const [selected, setSelected] = useState<EntityId | null>(session.demo ? seedConversations[0]?.id ?? null : null)
  const [messages, setMessages] = useState<ChatMessage[]>(session.demo ? initialMessages : [])
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [directoryError, setDirectoryError] = useState('')
  const [call, setCall] = useState<'voice' | 'video' | null>(null)
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null)
  const [connectedIncomingCall, setConnectedIncomingCall] = useState<CallSession | null>(null)
  const selectedConversation = useMemo(() => conversations.find((item) => item.id === selected) ?? null, [conversations, selected])
  const signaling = useMemo(() => new CallSignaling(), [])
  const refreshConversationPreview = useCallback((conversationId: EntityId, latest?: ChatMessage) => {
    if (!latest) return
    setConversations((current) => current.map((conversation) => String(conversation.id) === String(conversationId)
      ? { ...conversation, preview: latest.text, time: latest.time }
      : conversation
    ))
  }, [])
  const loadMessages = useCallback(async () => {
    if (session.demo || !selectedConversation) return
    const response = await api.textMessages(session.sessionId, selectedConversation.id)
    const remoteMessages = (response.items ?? []).map((message) => textMessageToChatMessage(message, session))
    setMessages((current) => {
      const otherMessages = current.filter((message) => String(message.conversationId) !== String(selectedConversation.id))
      return [...otherMessages, ...remoteMessages]
    })
    refreshConversationPreview(selectedConversation.id, remoteMessages.at(-1))
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
    if (session.demo) return
    const socket = signaling.connect(session.sessionId, (payload) => {
      if (payload.type === 'call_invite' && payload.fromUserId && payload.roomName) {
        setIncomingCall({ type: 'call_invite', callId: payload.callId, fromUserId: payload.fromUserId, roomName: payload.roomName })
        return
      }
      if (payload.type === 'call_group_started' && payload.fromUserId && payload.groupId && payload.roomName) {
        setIncomingCall({ type: 'call_group_started', callId: payload.callId, fromUserId: payload.fromUserId, groupId: payload.groupId, roomName: payload.roomName })
        return
      }
      if (payload.type === 'call_accepted_with_token' && payload.roomName && payload.token && payload.livekitUrl) {
        setConnectedIncomingCall({ roomName: payload.roomName, token: payload.token, livekitUrl: payload.livekitUrl })
        return
      }
      if (payload.type?.startsWith('call_')) console.info('MoChat call signal', payload)
    })
    socket.onerror = () => console.warn('MoChat call signaling disconnected')
    return () => signaling.disconnect()
  }, [session.demo, session.sessionId, signaling])
  useEffect(() => {
    if (session.demo || !selectedConversation) return
    let cancelled = false
    const refresh = async () => {
      try {
        if (!cancelled) await loadMessages()
      } catch (reason) {
        console.warn('MoChat message polling failed', reason)
      }
    }
    refresh()
    const timer = window.setInterval(refresh, 1500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
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
    if (attachments.length > 0) {
      for (const file of attachments) {
        const media = await api.uploadMedia(file)
        await api.sendMultimediaMessage(session.sessionId, selectedConversation, media)
      }
    }
    const response = await api.sendTextMessage(session.sessionId, selectedConversation, text)
    const sentMessage = textMessageToChatMessage(response.message, session)
    setMessages((current) => [
      ...current.filter((message) => String(message.id) !== String(sentMessage.id)),
      sentMessage,
    ])
    refreshConversationPreview(selectedConversation.id, sentMessage)
    await loadMessages()
  }
  return <main className="app-shell">
    <WindowControls />
    <Sidebar section={section} setSection={setSection} session={session} onLogout={onLogout} />
    {section === 'chats' ? <><ConversationList items={conversations} selected={selected} onSelect={setSelected} />{directoryLoading ? <section className="chat-panel"><EmptyState icon={<MessageSquare />} title="正在加载会话" text="正在从后端读取好友与群组" /></section> : selectedConversation ? <Chat conversation={selectedConversation} messages={messages} serviceMode={!session.demo} onSend={send} onCall={setCall} /> : <section className="chat-panel"><EmptyState icon={<MessageSquare />} title="暂无会话" text={directoryError || '后端当前没有返回好友或群组'} /></section>}</> : <Directory section={section} session={session} conversations={conversations} onRefreshDirectory={() => loadDirectory()} onOpenConversation={(conversationId) => { setSelected(conversationId); setSection('chats') }} />}
    <div className={`connection-pill ${session.demo ? 'demo' : ''}`}>{session.demo ? <WifiOff /> : <Wifi />}{session.demo ? '演示模式' : '服务已连接'}<ChevronDown /></div>
    {call && selectedConversation && <CallModal session={session} conversation={selectedConversation} kind={call} onClose={() => setCall(null)} />}
    {incomingCall && <IncomingCallModal session={session} incoming={incomingCall} signaling={signaling} connectedSession={connectedIncomingCall} onConnectedConsumed={() => setConnectedIncomingCall(null)} onClose={() => { setIncomingCall(null); setConnectedIncomingCall(null) }} />}
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
