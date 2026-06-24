const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron')
const { spawn } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')

const isDev = !app.isPackaged
const isTestWindow = process.argv.some((arg) => arg === '--mochat-test-window')

function launchTestWindow() {
  const userDataDir = path.join(os.tmpdir(), `mochat-test-${Date.now()}`)
  const args = isDev
    ? [app.getAppPath(), `--user-data-dir=${userDataDir}`, '--mochat-test-window']
    : [`--user-data-dir=${userDataDir}`, '--mochat-test-window']

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
  window.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media', 'camera', 'microphone'].includes(permission))
  })

  if (isDev) window.loadURL('http://localhost:5173')
  else window.loadFile(path.join(__dirname, '..', 'build', 'renderer', 'index.html'))
}

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
