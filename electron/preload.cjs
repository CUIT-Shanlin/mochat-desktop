const { contextBridge, ipcRenderer } = require('electron')

function getLaunchConfig() {
  const arg = process.argv.find((item) => item.startsWith('--mochat-config='))
  if (!arg) return {}
  try {
    return JSON.parse(Buffer.from(arg.slice('--mochat-config='.length), 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

contextBridge.exposeInMainWorld('mochatDesktop', {
  platform: process.platform,
  launchConfig: getLaunchConfig(),
  selectFiles: () => ipcRenderer.invoke('dialog:select-files'),
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
})
