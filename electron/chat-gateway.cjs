const tls = require('node:tls')
const crypto = require('node:crypto')
const protobuf = require('protobufjs')

const MAGIC = 0x4d4f4348
const VERSION = 1
const SERIALIZER = 1
const HEADER_LENGTH = 11
const HEARTBEAT_INTERVAL_MS = 15000
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 8000

const MsgType = {
  CLIENT_HEARTBEAT: 1,
  SERVER_HEARTBEAT: 2,
  PRIVATE_MESSAGE: 3,
  GROUP_MESSAGE: 4,
  SEND_ACK: 5,
  ERROR_RESPONSE: 6,
  CLIENT_RECEIVE_ACK: 7,
  DELIVERED_ACK: 8,
}

const proto = `
syntax = "proto3";
package mochat.v1;

message SendAck {
  int64 clientMsgId = 1;
  int64 msgId = 2;
  int64 seq = 3;
  int64 serverTimeMs = 4;
}

message ErrorResponse {
  int32 errorCode = 1;
  string message = 2;
}

message Heartbeat {
  int64 serverTimeMs = 1;
}

message PrivateMessageReq {
  string sessionId = 1;
  int64 clientMsgId = 2;
  int64 conversationId = 3;
  int64 toUid = 4;
  repeated MessageContent contents = 10;
}

message GroupMessageReq {
  string sessionId = 1;
  int64 clientMsgId = 2;
  int64 conversationId = 3;
  int64 groupId = 4;
  repeated MessageContent contents = 10;
}

message MessageContent {
  oneof content {
    EncryptedText encryptedText = 1;
    PlainText plainText = 2;
    MediaMetadata media = 3;
  }
}

message PlainText {
  string text = 1;
}

message ChatMessageDelivery {
  int64 msgId = 1;
  int64 seq = 2;
  int64 serverTimeMs = 3;
  int64 conversationId = 4;
  int64 fromUid = 5;
  repeated MessageContent contents = 10;
  oneof payload {
    PrivatePayload privatePayload = 11;
    GroupPayload groupPayload = 12;
  }
}

message PrivatePayload {
  int64 toUid = 1;
  repeated MessageContent contents = 2;
}

message GroupPayload {
  int64 groupId = 1;
  repeated MessageContent contents = 2;
}

message ClientReceiveAck {
  string sessionId = 1;
  int64 conversationId = 2;
  int64 latestReceivedSeq = 3;
}

message DeliveredAck {
  int64 conversationId = 1;
  int64 toUid = 2;
  int64 latestReceivedSeq = 3;
  int64 serverTimeMs = 4;
}

message EncryptedText {
  bytes nonce = 1;
  bytes ciphertext = 2;
}

message MediaMetadata {
  MediaType type = 1;
  string mediaUrl = 2;
  string thumbnailUrl = 3;
  int64 fileSize = 4;
  string mimeType = 5;
  string fileName = 6;
  int32 duration = 7;
  int32 width = 8;
  int32 height = 9;
  string previewText = 10;
  bytes waveformData = 11;
}

enum MediaType {
  IMAGE = 0;
  VIDEO = 1;
  AUDIO = 2;
  FILE = 3;
}
`

const root = protobuf.parse(proto).root
const Heartbeat = root.lookupType('mochat.v1.Heartbeat')
const SendAck = root.lookupType('mochat.v1.SendAck')
const ErrorResponse = root.lookupType('mochat.v1.ErrorResponse')
const PrivateMessageReq = root.lookupType('mochat.v1.PrivateMessageReq')
const GroupMessageReq = root.lookupType('mochat.v1.GroupMessageReq')
const ClientReceiveAck = root.lookupType('mochat.v1.ClientReceiveAck')
const DeliveredAck = root.lookupType('mochat.v1.DeliveredAck')
const ChatMessageDelivery = root.lookupType('mochat.v1.ChatMessageDelivery')

function toPlainObject(type, buffer) {
  return type.toObject(type.decode(buffer), {
    longs: String,
    enums: String,
    bytes: String,
    oneofs: true,
    defaults: false,
    arrays: true,
  })
}

function encodeFrame(msgType, bodyBuffer) {
  const body = Buffer.from(bodyBuffer)
  const frame = Buffer.allocUnsafe(HEADER_LENGTH + body.length)
  frame.writeUInt32BE(MAGIC, 0)
  frame.writeUInt8(VERSION, 4)
  frame.writeUInt8(msgType, 5)
  frame.writeUInt8(SERIALIZER, 6)
  frame.writeUInt32BE(body.length, 7)
  body.copy(frame, HEADER_LENGTH)
  return frame
}

function parseGatewayUrl(raw) {
  const normalized = raw.includes('://') ? raw : `tls://${raw}`
  const url = new URL(normalized)
  return {
    host: url.hostname,
    port: Number.parseInt(url.port || '9000', 10),
    tls: url.protocol !== 'tcp:',
  }
}

function shouldAllowSelfSigned(hostname) {
  return ['localhost', '127.0.0.1', '::1', '103.40.14.14'].includes(hostname)
}

class ChatGatewayClient {
  constructor(sendEvent) {
    this.sendEvent = sendEvent
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.heartbeatTimer = null
    this.reconnectTimer = null
    this.reconnectAttempts = 0
    this.connectOptions = null
    this.manualClose = false
    this.connected = false
  }

  connect({ gatewayUrl }) {
    this.manualClose = false
    this.connectOptions = parseGatewayUrl(gatewayUrl)
    this.openSocket()
  }

  disconnect() {
    this.manualClose = true
    this.clearReconnect()
    this.stopHeartbeat()
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    this.connected = false
  }

  sendHeartbeat() {
    this.sendFrame(MsgType.CLIENT_HEARTBEAT, Heartbeat, { serverTimeMs: Date.now().toString() })
  }

  sendPrivateMessage(payload) {
    this.sendFrame(MsgType.PRIVATE_MESSAGE, PrivateMessageReq, payload)
  }

  sendGroupMessage(payload) {
    this.sendFrame(MsgType.GROUP_MESSAGE, GroupMessageReq, payload)
  }

  sendReceiveAck(payload) {
    this.sendFrame(MsgType.CLIENT_RECEIVE_ACK, ClientReceiveAck, payload)
  }

  openSocket() {
    if (!this.connectOptions) return
    this.clearReconnect()
    this.stopHeartbeat()
    this.buffer = Buffer.alloc(0)
    const socket = tls.connect({
      host: this.connectOptions.host,
      port: this.connectOptions.port,
      rejectUnauthorized: !shouldAllowSelfSigned(this.connectOptions.host),
      minVersion: 'TLSv1.2',
    })
    this.socket = socket
    socket.once('secureConnect', () => {
      this.connected = true
      this.reconnectAttempts = 0
      this.sendEvent({ type: 'state', state: 'connected' })
      this.startHeartbeat()
    })
    socket.on('data', (chunk) => this.handleData(chunk))
    socket.on('error', (error) => {
      this.sendEvent({ type: 'socket-error', message: error.message })
    })
    socket.on('close', () => {
      this.connected = false
      this.stopHeartbeat()
      this.sendEvent({ type: 'state', state: 'disconnected' })
      if (!this.manualClose) this.scheduleReconnect()
    })
  }

  scheduleReconnect() {
    if (!this.connectOptions || this.reconnectTimer) return
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * (2 ** this.reconnectAttempts), RECONNECT_MAX_DELAY_MS)
    this.reconnectAttempts += 1
    this.sendEvent({ type: 'state', state: 'reconnecting', delayMs: delay })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, delay)
  }

  clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS)
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  sendFrame(msgType, type, payload) {
    if (!this.socket || !this.connected) throw new Error('聊天连接尚未建立')
    const message = type.create(payload)
    const body = type.encode(message).finish()
    this.socket.write(encodeFrame(msgType, body))
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= HEADER_LENGTH) {
      const magic = this.buffer.readUInt32BE(0)
      if (magic !== MAGIC) {
        this.sendEvent({ type: 'protocol-error', message: '聊天网关返回了非法帧头' })
        this.disconnect()
        return
      }
      const bodyLength = this.buffer.readUInt32BE(7)
      const frameLength = HEADER_LENGTH + bodyLength
      if (this.buffer.length < frameLength) return
      const msgType = this.buffer.readUInt8(5)
      const body = this.buffer.subarray(HEADER_LENGTH, frameLength)
      this.buffer = this.buffer.subarray(frameLength)
      this.handleFrame(msgType, body)
    }
  }

  handleFrame(msgType, body) {
    if (msgType === MsgType.SERVER_HEARTBEAT) {
      this.sendEvent({ type: 'heartbeat', payload: toPlainObject(Heartbeat, body) })
      return
    }
    if (msgType === MsgType.SEND_ACK) {
      this.sendEvent({ type: 'send-ack', payload: toPlainObject(SendAck, body) })
      return
    }
    if (msgType === MsgType.ERROR_RESPONSE) {
      this.sendEvent({ type: 'error-response', payload: toPlainObject(ErrorResponse, body) })
      return
    }
    if (msgType === MsgType.DELIVERED_ACK) {
      this.sendEvent({ type: 'delivered-ack', payload: toPlainObject(DeliveredAck, body) })
      return
    }
    if (msgType === MsgType.PRIVATE_MESSAGE || msgType === MsgType.GROUP_MESSAGE) {
      this.sendEvent({
        type: 'delivery',
        payload: {
          ...toPlainObject(ChatMessageDelivery, body),
          deliveryKind: msgType === MsgType.PRIVATE_MESSAGE ? 'private' : 'group',
        },
      })
    }
  }
}

function randomNonceBase64() {
  return crypto.randomBytes(12).toString('base64')
}

function textCiphertextBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64')
}

function mediaTypeCode(type) {
  return { image: 0, video: 1, audio: 2, file: 3 }[type] ?? 3
}

function buildPrivateTextPayload({ sessionId, clientMsgId, conversationId, toUid, text }) {
  return {
    sessionId,
    clientMsgId: String(clientMsgId),
    conversationId: String(conversationId),
    toUid: String(toUid),
    contents: [{ encryptedText: { nonce: randomNonceBase64(), ciphertext: textCiphertextBase64(text) } }],
  }
}

function buildGroupTextPayload({ sessionId, clientMsgId, conversationId, groupId, text }) {
  return {
    sessionId,
    clientMsgId: String(clientMsgId),
    conversationId: String(conversationId),
    groupId: String(groupId),
    contents: [{ plainText: { text } }],
  }
}

function buildMediaContent(media) {
  return {
    media: {
      type: mediaTypeCode(media.messageType),
      mediaUrl: media.mediaUrl,
      thumbnailUrl: media.thumbnailUrl || '',
      fileSize: String(media.fileSize || 0),
      mimeType: media.mimeType || '',
      fileName: media.fileName || '',
      duration: media.duration || 0,
      width: media.width || 0,
      height: media.height || 0,
      previewText: media.previewText || '',
      waveformData: media.waveformData || '',
    },
  }
}

function buildPrivateMediaPayload({ sessionId, clientMsgId, conversationId, toUid, media }) {
  return {
    sessionId,
    clientMsgId: String(clientMsgId),
    conversationId: String(conversationId),
    toUid: String(toUid),
    contents: [buildMediaContent(media)],
  }
}

function buildGroupMediaPayload({ sessionId, clientMsgId, conversationId, groupId, media }) {
  return {
    sessionId,
    clientMsgId: String(clientMsgId),
    conversationId: String(conversationId),
    groupId: String(groupId),
    contents: [buildMediaContent(media)],
  }
}

module.exports = {
  ChatGatewayClient,
  buildGroupMediaPayload,
  buildGroupTextPayload,
  buildPrivateMediaPayload,
  buildPrivateTextPayload,
}
