const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mochatDesktop', {
  platform: process.platform,
  selectFiles: () => ipcRenderer.invoke('dialog:select-files'),
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
})
