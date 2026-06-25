// 端到端加密助手：在 Electron 主进程做 X25519 派生共享密钥 + AES-256-GCM 加解密。
// 服务端只存 opaque payload_base64，私聊密文格式：12 字节 nonce ‖ ciphertext ‖ 16 字节 authTag
// （由 bytes 字段直接承载）。群聊一律走 PlainText，不加密。

const crypto = require('node:crypto')

// 服务器 seed 数据：用户名 → { userId, publicKeyBase64, privateKeyBase64 }
// 服务端 PostgreSQL 已经写入这五个用户，公私钥对由 X25519 生成。
// 客户端登录这些已知用户时直接复用 seed 里的 publicKey；
// 登录未知用户名时退化到随机身份密钥（供后端新自动开户场景使用）。
const SEED_USERS = {
  alice: {
    userId: 1001,
    publicKeyBase64: 'kKLWF9BhKhM9Hpa8hHJ5GSwT1siclljWTfSXICzXglg=',
    privateKeyBase64: 'MA7YbjK4Nto8SS6ShSX1Iy70O0vMQaL7ZMBPMPwurWA=',
  },
  bob: {
    userId: 1002,
    publicKeyBase64: 'zRqkJgR0wYAE1KcZbFlNgdRmyrX6qjcE+mbdxESTyCI=',
    privateKeyBase64: 'iJ2kk0sYMe2G3gpG05bwY6s5fMBer8dZUAoZYDmGxm0=',
  },
  carol: {
    userId: 1003,
    publicKeyBase64: 'AebyWTXbesZyM/84CZicekytA4r80ElO0gugdiLFxB8=',
    privateKeyBase64: 'EJDhTxOlZYi7tKtbZsibetQABweSa6t5vFqA9KxqOnQ=',
  },
  dave: {
    userId: 1004,
    publicKeyBase64: 'LI3DiEPX+h4dDMKPnOjGA9oUNpqFN04oXdSKZkGe7VQ=',
    privateKeyBase64: 'mPJEQwChdc5sFKg4v5jO20YB5UAVnBJP3EOP//EvMVo=',
  },
  eve: {
    userId: 1005,
    publicKeyBase64: 'MysFrPmPK5CfEeTj5f3xr8e+42ThZ5uWxftdoNq/3W4=',
    privateKeyBase64: 'mNwgVeIjqZlZ6b+rHNPUmBXsNEKRKEL6TjVQXg3P+30=',
  },
}

function base64ToBytes(base64) {
  return Buffer.from(base64, 'base64')
}

function bytesToBase64(buffer) {
  return Buffer.from(buffer).toString('base64')
}

// X25519 私钥 → 公钥
function publicKeyFromPrivateKey(privateKeyBase64) {
  const privateKey = base64ToBytes(privateKeyBase64)
  // node:crypto 的 diffieHellman 不直接支持 X25519，
  // X25519 的公钥计算公式：私钥 (32B) → 公钥 = scalarmult_base(privateKey)
  // 使用 Node 内置的 crypto.createECDH('X25519')：
  const ec = crypto.createECDH('X25519')
  ec.setPrivateKey(privateKey)
  return bytesToBase64(ec.getPublicKey())
}

// X25519 ECDH：自己的私钥 + 对端的公钥 → 32 字节共享密钥
function deriveSharedKey(myPrivateKeyBase64, peerPublicKeyBase64) {
  const ec = crypto.createECDH('X25519')
  ec.setPrivateKey(base64ToBytes(myPrivateKeyBase64))
  return ec.computeSecret(base64ToBytes(peerPublicKeyBase64))
}

// AES-256-GCM 加密
// 返回 { nonceBase64, ciphertextBase64 }，ciphertext 末尾拼 16 字节 authTag
function encrypt(sharedKey, plaintextUtf8) {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', sharedKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintextUtf8, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const payload = Buffer.concat([ciphertext, tag])
  return {
    nonceBase64: bytesToBase64(nonce),
    ciphertextBase64: bytesToBase64(payload),
  }
}

// AES-256-GCM 解密；输入 ciphertext 末尾含 16 字节 authTag
function decrypt(sharedKey, nonceBase64, ciphertextBase64) {
  const nonce = base64ToBytes(nonceBase64)
  const payload = base64ToBytes(ciphertextBase64)
  if (payload.length < 16) throw new Error('ciphertext too short for GCM tag')
  const ciphertext = payload.subarray(0, payload.length - 16)
  const tag = payload.subarray(payload.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', sharedKey, nonce)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plain.toString('utf8')
}

// 根据用户名查 seed 中的私钥（仅 seed 用户可用）
function privateKeyFor(username) {
  return SEED_USERS[username]?.privateKeyBase64 || null
}

// 给登录用的 publicKey：seed 用户复用 seed 里的；其他用户随机生成 32 字节
function publicKeyForLogin(username) {
  const seed = SEED_USERS[username]
  if (seed) return seed.publicKeyBase64
  return bytesToBase64(crypto.randomBytes(32))
}

// 给一个 username 返回它的 userId（seed 用户），未知时返回 null
function seedUserIdFor(username) {
  return SEED_USERS[username]?.userId ?? null
}

// 用 seed 数据：根据本机 username + 对端 username 派生共享密钥
// 任意一边不在 seed 中则返回 null（要 fallback 到明文演示路径）
function sharedKeyForPeer(myUsername, peerUsername) {
  const me = SEED_USERS[myUsername]
  const peer = SEED_USERS[peerUsername]
  if (!me || !peer) return null
  return deriveSharedKey(me.privateKeyBase64, peer.publicKeyBase64)
}

// 给 renderer 使用的：拿 userId 反查 username
// 这张反查表用在 delivery 接收时取发送人 username，从而做 ECDH
const USERNAME_BY_USERID = Object.fromEntries(
  Object.entries(SEED_USERS).map(([name, info]) => [String(info.userId), name]),
)

// 给 renderer 的 encrypt bridge：接收 { myUsername, peerUsername, plaintext }
// 返回 { nonceBase64, ciphertextBase64 }，失败返回 { error }
function encryptForClient({ myUsername, peerUsername, plaintext }) {
  try {
    const sharedKey = sharedKeyForPeer(myUsername, peerUsername)
    if (!sharedKey) return { error: 'no-shared-key' }
    return encrypt(sharedKey, plaintext)
  } catch (error) {
    return { error: error?.message || 'encrypt-failed' }
  }
}

// 给 renderer 的 decrypt bridge：接收 { myUsername, peerUsername, nonceBase64, ciphertextBase64 }
// 返回 { plaintext } 或 { error }
function decryptForClient({ myUsername, peerUsername, nonceBase64, ciphertextBase64 }) {
  try {
    const sharedKey = sharedKeyForPeer(myUsername, peerUsername)
    if (!sharedKey) return { error: 'no-shared-key' }
    const plaintext = decrypt(sharedKey, nonceBase64, ciphertextBase64)
    return { plaintext }
  } catch (error) {
    return { error: error?.message || 'decrypt-failed' }
  }
}

module.exports = {
  SEED_USERS,
  USERNAME_BY_USERID,
  publicKeyFromPrivateKey,
  deriveSharedKey,
  encrypt,
  decrypt,
  privateKeyFor,
  publicKeyForLogin,
  seedUserIdFor,
  sharedKeyForPeer,
  encryptForClient,
  decryptForClient,
}