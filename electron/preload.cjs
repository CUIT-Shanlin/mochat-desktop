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
  // 把当前登录用户身份告诉主进程，主进程做 E2EE 时需要本地 username 来查 seed 私钥。
  setUser: (payload) => ipcRenderer.invoke('session:set-user', payload),
  seedUserIdFor: (username) => ipcRenderer.invoke('session:seed-user-id', username),
  usernameByUserId: (userId) => ipcRenderer.invoke('session:username-by-id', userId),
  decryptHistory: (payload) => ipcRenderer.invoke('chat:decrypt-history', payload),
  chat: {
    connect: (payload) => ipcRenderer.invoke('chat:connect', payload),
    disconnect: () => ipcRenderer.invoke('chat:disconnect'),
    // sendPrivateText payload 多带 fromUsername/peerUsername，主进程做 X25519+AES-GCM 加密。
    sendPrivateText: (payload) => ipcRenderer.invoke('chat:send-private-text', payload),
    sendGroupText: (payload) => ipcRenderer.invoke('chat:send-group-text', payload),
    sendPrivateMedia: (payload) => ipcRenderer.invoke('chat:send-private-media', payload),
    sendGroupMedia: (payload) => ipcRenderer.invoke('chat:send-group-media', payload),
    sendReceiveAck: (payload) => ipcRenderer.invoke('chat:send-receive-ack', payload),
    onEvent: (listener) => {
      const wrapped = (_event, payload) => listener(payload)
      ipcRenderer.on('chat:event', wrapped)
      return () => ipcRenderer.removeListener('chat:event', wrapped)
    },
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
})