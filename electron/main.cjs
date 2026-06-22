const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('node:path')

const isDev = !app.isPackaged

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
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
