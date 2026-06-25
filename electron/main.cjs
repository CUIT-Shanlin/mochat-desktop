const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const {
  ChatGatewayClient,
  buildGroupMediaPayload,
  buildGroupTextPayload,
  buildPrivateMediaPayload,
  buildPrivateTextPayload,
} = require('./chat-gateway.cjs')
const e2ee = require('./e2ee.cjs')

// 当前登录用户名 → 由 renderer 在登录成功后通过 `session:set-user` 注入。
// 主进程需要在私聊发送前做 AES-256-GCM 加密、在私聊接收时解密，
// 所以必须知道本地用户名和对方用户名（用来从 seed 取 X25519 私钥/对端公钥）。
let currentUsername = ''
let currentUserId = ''

const isDev = !app.isPackaged
const isTestWindow = process.argv.some((arg) => arg === '--mochat-test-window')
const devRendererUrl = 'http://localhost:5173'
const packagedRendererPath = path.join(__dirname, '..', 'build', 'renderer', 'index.html')
const packagedRendererPort = 39271
let packagedRendererUrl = ''
let rendererServer = null
const chatClients = new Map()

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

function encodeLaunchConfig(config) {
  return Buffer.from(JSON.stringify(config), 'utf8').toString('base64url')
}

async function readConnectionConfig() {
  const window = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  if (!window) return {}
  try {
    return await window.webContents.executeJavaScript(`({
      server: localStorage.getItem('mochat.server'),
      callServer: localStorage.getItem('mochat.callServer'),
      callWs: localStorage.getItem('mochat.callWs'),
      mediaServer: localStorage.getItem('mochat.mediaServer'),
    })`, true)
  } catch {
    return {}
  }
}

async function launchTestWindow() {
  const userDataDir = path.join(os.tmpdir(), `mochat-test-${Date.now()}`)
  const config = await readConnectionConfig()
  const launchConfigArg = `--mochat-config=${encodeLaunchConfig(config)}`
  const args = isDev
    ? [app.getAppPath(), `--user-data-dir=${userDataDir}`, '--mochat-test-window', launchConfigArg]
    : [`--user-data-dir=${userDataDir}`, '--mochat-test-window', launchConfigArg]

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

function setupMenus() {
  const testWindowItem = {
    label: '新建测试窗口（多账号）',
    accelerator: 'CmdOrCtrl+Shift+N',
    click: launchTestWindow,
  }
  const editMenu = {
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
      { role: 'delete', label: '删除' },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' },
    ],
  }

  if (process.platform === 'darwin') {
    app.dock?.setMenu(Menu.buildFromTemplate([testWindowItem]))
  }

  const template = [
    ...(process.platform === 'darwin'
      ? [{
          label: app.name,
          submenu: [
            { label: '关于 MoChat', role: 'about' },
            { type: 'separator' },
            testWindowItem,
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    editMenu,
    {
      label: '测试',
      submenu: [testWindowItem],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    backgroundColor: '#0d1524',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isRendererNavigation(url)) return
    event.preventDefault()
    loadRenderer(window)
  })
  window.webContents.on('did-navigate', (_event, url) => {
    if (!isRendererNavigation(url)) loadRenderer(window)
  })
  window.webContents.on('did-fail-load', (_event, _errorCode, _errorDescription, validatedUrl, isMainFrame) => {
    if (isMainFrame && !isRendererNavigation(validatedUrl)) loadRenderer(window)
  })
  window.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media', 'camera', 'microphone'].includes(permission))
  })
  window.webContents.on('context-menu', (_event, params) => {
    const template = params.isEditable
      ? [
          { role: 'undo', label: '撤销', enabled: params.editFlags.canUndo },
          { role: 'redo', label: '重做', enabled: params.editFlags.canRedo },
          { type: 'separator' },
          { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
          { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
          { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
          { role: 'delete', label: '删除', enabled: params.editFlags.canDelete },
          { type: 'separator' },
          { role: 'selectAll', label: '全选', enabled: params.editFlags.canSelectAll },
        ]
      : [
          { role: 'copy', label: '复制', enabled: Boolean(params.selectionText) },
          { type: 'separator' },
          { role: 'selectAll', label: '全选' },
        ]
    Menu.buildFromTemplate(template).popup({ window })
  })

  window.on('closed', () => {
    const client = chatClients.get(window.webContents.id)
    client?.disconnect()
    chatClients.delete(window.webContents.id)
  })

  loadRenderer(window)
}

function chatClientFor(sender) {
  const key = sender.id
  if (chatClients.has(key)) return chatClients.get(key)
  const client = new ChatGatewayClient((event) => {
    if (sender.isDestroyed()) return
    // 私聊：在这里统一做端到端解密，把 ciphertext 替换成 plaintext，再发给 renderer。
    // renderer 不持有任何私钥，只看到的等于群聊 PlainText 的形态。
    if (event.type === 'delivery') {
      try {
        const patched = decryptDeliveryIfNeeded(event.payload)
        if (patched) event.payload = patched
      } catch (error) {
        console.warn('MoChat decrypt delivery failed', error)
      }
    }
    sender.send('chat:event', event)
  })
  chatClients.set(key, client)
  return client
}

// 解析 delivery payload，找到 EncryptedText 内容，
// 用本地 username 与发送方 username 做 X25519+AES-GCM 解密。
// 成功时返回新 payload（contents[0].plainText.text = 明文 + 移除 encryptedText）；
// 失败或无需解密（群聊 / 媒体 / 未知 sender）时返回 null。
function decryptDeliveryIfNeeded(payload) {
  if (!payload || !currentUsername) return null
  const fromUid = String(payload.fromUid ?? '')
  if (!fromUid) return null
  const peerUsername = e2ee.USERNAME_BY_USERID[fromUid]
  if (!peerUsername) return null
  const contents = Array.isArray(payload.contents) ? payload.contents : []
  if (contents.length === 0) return null
  const first = contents[0] || {}
  const enc = first.encryptedText
  if (!enc || !enc.nonce || !enc.ciphertext) return null
  const result = e2ee.decryptForClient({
    myUsername: currentUsername,
    peerUsername,
    nonceBase64: enc.nonce,
    ciphertextBase64: enc.ciphertext,
  })
  if (result.error || typeof result.plaintext !== 'string') return null
  // 用 plaintext 形式重新组装 contents，让 renderer 当群聊一样显示。
  return {
    ...payload,
    contents: [{ plainText: { text: result.plaintext } }],
  }
}

function isRendererNavigation(url) {
  if (isDev) return url === devRendererUrl || url.startsWith(`${devRendererUrl}/`)
  return Boolean(packagedRendererUrl) && (url === packagedRendererUrl || url.startsWith(packagedRendererUrl))
}

function loadRenderer(window) {
  if (isDev) {
    if (window.webContents.getURL() !== devRendererUrl) window.loadURL(devRendererUrl)
    return
  }
  if (window.webContents.getURL() !== packagedRendererUrl) window.loadURL(packagedRendererUrl)
}

function startPackagedRendererServer() {
  if (isDev || rendererServer) return Promise.resolve()
  const root = path.dirname(packagedRendererPath)
  const mimeTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.svg', 'image/svg+xml; charset=utf-8'],
    ['.webp', 'image/webp'],
    ['.ico', 'image/x-icon'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2'],
  ])

  rendererServer = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
    const decodedPath = decodeURIComponent(requestUrl.pathname)
    const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '')
    const requestedFile = path.normalize(path.join(root, relativePath))
    const insideRendererRoot = requestedFile === root || requestedFile.startsWith(`${root}${path.sep}`)
    const filePath = insideRendererRoot ? requestedFile : packagedRendererPath

    fs.stat(filePath, (statError, stats) => {
      const finalPath = statError || !stats.isFile() ? packagedRendererPath : filePath
      response.setHeader('Content-Type', mimeTypes.get(path.extname(finalPath)) || 'application/octet-stream')
      fs.createReadStream(finalPath)
        .on('error', () => {
          response.writeHead(500)
          response.end('Renderer asset unavailable')
        })
        .pipe(response)
    })
  })

  return new Promise((resolve, reject) => {
    let attempts = 0
    const listen = () => {
      rendererServer.once('error', (error) => {
        if (error.code === 'EADDRINUSE' && attempts < 10) {
          attempts += 1
          listen()
          return
        }
        reject(error)
      })
      rendererServer.listen(packagedRendererPort + attempts, '127.0.0.1')
    }

    rendererServer.once('listening', () => {
      const address = rendererServer.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind packaged renderer server'))
        return
      }
      packagedRendererUrl = `http://127.0.0.1:${address.port}/`
      resolve()
    })
    listen()
  })
}

app.on('open-file', (event) => {
  event.preventDefault()
})

ipcMain.handle('dialog:select-files', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'mp3', 'wav', 'pdf', 'doc', 'docx'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('chat:connect', async (event, payload) => {
  chatClientFor(event.sender).connect(payload)
  return { ok: true }
})

// renderer 登录后把本机 user 身份告诉主进程，用于后续私聊 ECDH 加解密。
// 同时保留 currentUserId，方便在日志和后续 peer 查询用。
ipcMain.handle('session:set-user', async (event, payload) => {
  currentUsername = String(payload?.username || '')
  currentUserId = String(payload?.userId || '')
  return { ok: true, username: currentUsername, userId: currentUserId }
})

// 给 renderer 反查 seed userId（登录前已知用户名时直接拿）。
ipcMain.handle('session:seed-user-id', async (event, username) => {
  return e2ee.seedUserIdFor(String(username || ''))
})

// 给 renderer 反查 seed username by userId（接收 delivery 时确定发送方是谁）。
ipcMain.handle('session:username-by-id', async (event, userId) => {
  return e2ee.USERNAME_BY_USERID[String(userId)] || null
})

// 解密私聊历史消息：renderer 拉到 history items 后批量送过来，
// 主进程用 currentUsername + peerUsername 做 X25519+AES-GCM 解密，
// 解不出来的 item 原样返回（renderer 会按 ciphertext 显示 [加密消息]）。
ipcMain.handle('chat:decrypt-history', async (event, payload) => {
  const items = Array.isArray(payload?.items) ? payload.items : []
  const peerUsername = payload?.peerUsername
  const kind = payload?.kind || 'private'
  if (kind !== 'private' || !peerUsername || !currentUsername) return items
  const { decodeHistoryItem } = require('./history-decode.cjs')
  return items.map((item) => {
    try {
      if (!item?.payloadBase64) return item
      const decoded = decodeHistoryItem(item.payloadBase64, 'private')
      const enc = decoded?.contents?.[0]?.encryptedText
      if (!enc || !enc.nonce || !enc.ciphertext) return item
      const result = e2ee.decryptForClient({
        myUsername: currentUsername,
        peerUsername,
        nonceBase64: enc.nonce,
        ciphertextBase64: enc.ciphertext,
      })
      if (result.error) return item
      return { ...item, decryptedText: result.plaintext }
    } catch {
      return item
    }
  })
})

ipcMain.handle('chat:disconnect', async (event) => {
  chatClientFor(event.sender).disconnect()
  return { ok: true }
})

ipcMain.handle('chat:send-private-text', async (event, payload) => {
  // 私聊：在这里做端到端加密。payload.fromUsername / payload.peerUsername 由 renderer 注入；
  // 加密后交给 ChatGatewayClient 打包 EncryptedText 帧。
  const { text, fromUsername, peerUsername, ...rest } = payload
  const enc = e2ee.encryptForClient({ myUsername: fromUsername, peerUsername, plaintext: text })
  if (enc.error) {
    // 没有 seed 密钥对（任意一边不是 seed 用户）时退回 base64 兜底，让链路至少能透传。
    const fallback = Buffer.from(text, 'utf8').toString('base64')
    chatClientFor(event.sender).sendPrivateMessage(buildPrivateTextPayload({
      ...rest,
      nonceBase64: Buffer.alloc(12, 0).toString('base64'),
      ciphertextBase64: fallback,
    }))
    return { ok: true }
  }
  chatClientFor(event.sender).sendPrivateMessage(buildPrivateTextPayload({
    ...rest,
    nonceBase64: enc.nonceBase64,
    ciphertextBase64: enc.ciphertextBase64,
  }))
  return { ok: true }
})

ipcMain.handle('chat:send-group-text', async (event, payload) => {
  chatClientFor(event.sender).sendGroupMessage(buildGroupTextPayload(payload))
  return { ok: true }
})

ipcMain.handle('chat:send-private-media', async (event, payload) => {
  chatClientFor(event.sender).sendPrivateMessage(buildPrivateMediaPayload(payload))
  return { ok: true }
})

ipcMain.handle('chat:send-group-media', async (event, payload) => {
  chatClientFor(event.sender).sendGroupMessage(buildGroupMediaPayload(payload))
  return { ok: true }
})

ipcMain.handle('chat:send-receive-ack', async (event, payload) => {
  chatClientFor(event.sender).sendReceiveAck({
    sessionId: payload.sessionId,
    conversationId: String(payload.conversationId),
    latestReceivedSeq: String(payload.latestReceivedSeq),
  })
  return { ok: true }
})

ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
ipcMain.on('window:maximize', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) return
  window.isMaximized() ? window.unmaximize() : window.maximize()
})
ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())

app.whenReady().then(async () => {
  await startPackagedRendererServer()
  setupMenus()
  createWindow()
  if (isTestWindow) app.setName('MoChat 测试窗口')
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  rendererServer?.close()
})
