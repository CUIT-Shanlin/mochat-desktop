const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron')
const { spawn } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const isDev = !app.isPackaged
const isTestWindow = process.argv.some((arg) => arg === '--mochat-test-window')
const devRendererUrl = 'http://localhost:5173'
const packagedRendererPath = path.join(__dirname, '..', 'build', 'renderer', 'index.html')
const packagedRendererUrl = pathToFileURL(packagedRendererPath).toString()

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

  loadRenderer(window)
}

function isRendererNavigation(url) {
  if (isDev) return url === devRendererUrl || url.startsWith(`${devRendererUrl}/`)
  return url === packagedRendererUrl
}

function loadRenderer(window) {
  if (isDev) {
    if (window.webContents.getURL() !== devRendererUrl) window.loadURL(devRendererUrl)
    return
  }
  if (window.webContents.getURL() !== packagedRendererUrl) window.loadFile(packagedRendererPath)
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

ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
ipcMain.on('window:maximize', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) return
  window.isMaximized() ? window.unmaximize() : window.maximize()
})
ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())

app.whenReady().then(() => {
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
