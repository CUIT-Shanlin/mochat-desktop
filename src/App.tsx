import { useMemo, useState } from 'react'
import {
  Check, ChevronDown, ContactRound, FileText, Image, Info, LogOut, Menu,
  MessageSquare, Mic, Minus, MoreVertical, Paperclip, Phone, Plus, Search, Send,
  Settings, Smile, UserPlus, Users, Video, Volume2, Wifi, WifiOff, X,
} from 'lucide-react'
import './App.css'
import { api } from './api'
import { Avatar, EmptyState, Logo, Modal } from './components'
import { conversations as seedConversations, friendRequests, initialMessages } from './data'
import type { ChatMessage, Conversation, Session } from './types'

type Section = 'chats' | 'contacts' | 'groups' | 'requests' | 'settings'

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
      <p>系统会为 <strong>{username.trim()}</strong> 生成本地身份公钥。若后端当前不可用，将进入演示模式，你仍可体验全部客户端交互。</p>
    </Modal>}
  </main>
}

function Sidebar({ section, setSection, session, onLogout }: { section: Section; setSection: (section: Section) => void; session: Session; onLogout: () => void }) {
  const nav: { id: Section; label: string; icon: typeof MessageSquare; badge?: number }[] = [
    { id: 'chats', label: '消息', icon: MessageSquare, badge: 2 },
    { id: 'contacts', label: '联系人', icon: ContactRound },
    { id: 'groups', label: '群组', icon: Users },
    { id: 'requests', label: '新的朋友', icon: UserPlus, badge: 2 },
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

function ConversationList({ items, selected, onSelect }: { items: Conversation[]; selected: number; onSelect: (id: number) => void }) {
  const [query, setQuery] = useState('')
  const filtered = items.filter((item) => `${item.name}${item.preview}`.toLowerCase().includes(query.toLowerCase()))
  return <aside className="conversation-panel">
    <div className="drag-region panel-drag" />
    <div className="search-row"><div className="search-box"><Search /><input aria-label="搜索会话" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索联系人、群聊、消息" /></div><button className="add-button" title="新建会话"><Plus /></button></div>
    <div className="panel-heading"><span>最近消息</span><button><Menu /></button></div>
    <div className="conversation-list">{filtered.map((item) => <button key={item.id} className={`conversation-item ${selected === item.id ? 'active' : ''}`} onClick={() => onSelect(item.id)}>
      <Avatar initials={item.initials} color={item.color} online={item.online} />
      <span className="conversation-copy"><strong>{item.name}</strong><small>{item.preview}</small></span>
      <span className="conversation-meta"><time>{item.time}</time>{item.unread > 0 && <b>{item.unread}</b>}</span>
    </button>)}</div>
  </aside>
}

function Chat({ conversation, messages, onSend, onCall }: { conversation: Conversation; messages: ChatMessage[]; onSend: (text: string) => void; onCall: (kind: 'voice' | 'video') => void }) {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const current = messages.filter((message) => message.conversationId === conversation.id)
  async function attach() {
    const files = window.mochatDesktop ? await window.mochatDesktop.selectFiles() : []
    setAttachments(files)
  }
  function send() {
    const text = draft.trim() || (attachments.length ? `📎 ${attachments.map((file) => file.split(/[\\/]/).pop()).join('、')}` : '')
    if (!text) return
    onSend(text); setDraft(''); setAttachments([])
  }
  return <section className="chat-panel">
    <header className="chat-header"><div className="chat-person"><Avatar initials={conversation.initials} color={conversation.color} size="sm" online={conversation.online} /><span><strong>{conversation.name}</strong><small>{conversation.online ? '在线' : conversation.kind === 'group' ? '5 位成员' : '离线'}</small></span></div><div className="chat-actions"><button onClick={() => onCall('voice')} title="语音通话"><Phone /></button><button onClick={() => onCall('video')} title="视频通话"><Video /></button><button title="会话详情"><MoreVertical /></button></div></header>
    <div className="message-area">
      <div className="date-divider"><span>今天</span></div>
      {current.length === 0 ? <EmptyState icon={<MessageSquare />} title="开始聊天" text={`向 ${conversation.name} 发送第一条消息`} /> : current.map((message) => <div key={message.id} className={`message-row ${message.fromMe ? 'mine' : ''}`}>
        {!message.fromMe && <Avatar initials={conversation.initials} color={conversation.color} size="sm" />}
        <div><div className="message-bubble">{message.text}</div><div className="message-time">{message.time}{message.fromMe && message.status === 'read' && <><Check /><Check /></>}</div></div>
      </div>)}
    </div>
    <footer className="composer">
      {attachments.length > 0 && <div className="attachment-preview"><FileText /><span>{attachments.map((file) => file.split(/[\\/]/).pop()).join('、')}</span><button onClick={() => setAttachments([])}><X /></button></div>}
      <div className="composer-tools"><button title="表情"><Smile /></button><button title="选择图片"><Image /></button><button title="添加附件" onClick={attach}><Paperclip /></button><button title="语音消息"><Mic /></button></div>
      <textarea aria-label="消息" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } }} placeholder="输入消息，Enter 发送，Shift + Enter 换行" />
      <button className="send-button" disabled={!draft.trim() && !attachments.length} onClick={send}><Send /><span>发送</span></button>
    </footer>
  </section>
}

function Directory({ section, session }: { section: Exclude<Section, 'chats'>; session: Session }) {
  const [requests, setRequests] = useState(friendRequests)
  const [server, setServer] = useState(localStorage.getItem('mochat.server') || import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080')
  const [notifications, setNotifications] = useState(true)
  if (section === 'settings') return <section className="page-panel"><header><h1>设置</h1><p>管理客户端偏好与服务连接</p></header><div className="settings-card"><h3>账号</h3><div className="account-row"><Avatar initials={session.username[0]} color="#607be8" size="lg" /><div><strong>{session.username}</strong><span>用户 ID：{session.userId}</span><em>{session.demo ? '演示模式' : '已连接服务'}</em></div></div></div><div className="settings-card"><h3>连接</h3><label>API 服务地址<input value={server} onChange={(event) => setServer(event.target.value)} /></label><button className="primary-button" onClick={() => localStorage.setItem('mochat.server', server)}>保存配置</button></div><div className="settings-card toggle-row"><div><h3>桌面通知</h3><p>收到新消息时显示系统通知</p></div><button className={`toggle ${notifications ? 'on' : ''}`} onClick={() => setNotifications(!notifications)}><i /></button></div></section>
  if (section === 'requests') return <section className="page-panel"><header><h1>新的朋友</h1><p>{requests.filter((item) => item.status === 'pending').length} 个待处理申请</p></header><div className="directory-list">{requests.map((request) => <div className="request-row" key={request.id}><Avatar initials={request.name[0]} color={request.id === 1 ? '#7b69d9' : '#3a9d89'} /><div><strong>{request.name}</strong><span>{request.message}</span><small>用户 ID：{request.userId}</small></div>{request.status === 'pending' ? <div className="request-actions"><button onClick={() => setRequests(requests.map((item) => item.id === request.id ? { ...item, status: 'rejected' } : item))}>忽略</button><button className="primary-button" onClick={() => setRequests(requests.map((item) => item.id === request.id ? { ...item, status: 'accepted' } : item))}>接受</button></div> : <em>{request.status === 'accepted' ? '已添加' : '已忽略'}</em>}</div>)}</div></section>
  const isGroup = section === 'groups'
  const source = seedConversations.filter((item) => isGroup ? item.kind === 'group' : item.kind === 'private')
  return <section className="page-panel"><header><div><h1>{isGroup ? '群组' : '联系人'}</h1><p>{source.length} {isGroup ? '个群聊' : '位联系人'}</p></div><button className="primary-button"><Plus />{isGroup ? '创建群组' : '添加好友'}</button></header><div className="directory-list">{source.map((item) => <div className="directory-row" key={item.id}><Avatar initials={item.initials} color={item.color} online={item.online} /><div><strong>{item.name}</strong><span>{isGroup ? `${item.targetId} · 5 位成员` : `用户 ID：${item.targetId}`}</span></div><button className="ghost-button"><MessageSquare />发消息</button><button className="icon-button"><MoreVertical /></button></div>)}</div></section>
}

function CallModal({ conversation, kind, onClose }: { conversation: Conversation; kind: 'voice' | 'video'; onClose: () => void }) {
  return <div className="call-backdrop"><section className="call-card"><div className="call-pulse"><Avatar initials={conversation.initials} color={conversation.color} size="lg" /></div><h2>{conversation.name}</h2><p>{kind === 'video' ? '正在发起视频通话…' : '正在发起语音通话…'}</p><div className="call-status"><Wifi />端到端加密连接</div><div className="call-buttons"><button><Volume2 /></button><button><Mic /></button><button className="hangup" onClick={onClose}><Phone /></button></div></section></div>
}

function MainApp({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [section, setSection] = useState<Section>('chats')
  const [selected, setSelected] = useState(seedConversations[0].id)
  const [messages, setMessages] = useState(initialMessages)
  const [call, setCall] = useState<'voice' | 'video' | null>(null)
  const selectedConversation = useMemo(() => seedConversations.find((item) => item.id === selected) ?? seedConversations[0], [selected])
  function send(text: string) {
    const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    setMessages((current) => [...current, { id: Date.now(), conversationId: selected, fromMe: true, text, time: now, status: 'sent' }])
  }
  return <main className="app-shell">
    <WindowControls />
    <Sidebar section={section} setSection={setSection} session={session} onLogout={onLogout} />
    {section === 'chats' ? <><ConversationList items={seedConversations} selected={selected} onSelect={setSelected} /><Chat conversation={selectedConversation} messages={messages} onSend={send} onCall={setCall} /></> : <Directory section={section} session={session} />}
    <div className={`connection-pill ${session.demo ? 'demo' : ''}`}>{session.demo ? <WifiOff /> : <Wifi />}{session.demo ? '演示模式' : '服务已连接'}<ChevronDown /></div>
    {call && <CallModal conversation={selectedConversation} kind={call} onClose={() => setCall(null)} />}
  </main>
}

export default function App() {
  const [session, setSession] = useState<Session | null>(() => {
    try { return JSON.parse(localStorage.getItem('mochat.session') || 'null') }
    catch { return null }
  })
  function logout() { localStorage.removeItem('mochat.session'); setSession(null) }
  return session ? <MainApp session={session} onLogout={logout} /> : <Login onLogin={setSession} />
}
