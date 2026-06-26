import protobuf from 'protobufjs'
import type { BackendHistoryItem, ChatGatewayDelivery, ChatGatewaySendAck, ChatGatewayDeliveredAck, ChatGatewayError } from './types'

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

const PrivateMessageReq = root.lookupType('mochat.v1.PrivateMessageReq')
const GroupMessageReq = root.lookupType('mochat.v1.GroupMessageReq')
const ChatMessageDelivery = root.lookupType('mochat.v1.ChatMessageDelivery')

function base64ToBytes(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function decodeMessage(type: protobuf.Type, bytes: Uint8Array) {
  return type.toObject(type.decode(bytes), {
    longs: String,
    enums: String,
    bytes: String,
    oneofs: true,
    defaults: false,
    arrays: true,
  }) as Record<string, unknown>
}

export function decodeHistoryItem(item: BackendHistoryItem, kind: 'private' | 'group') {
  const bytes = base64ToBytes(item.payloadBase64)
  let decoded: Record<string, unknown> | null = null
  try {
    decoded = kind === 'private'
      ? decodeMessage(PrivateMessageReq, bytes)
      : decodeMessage(GroupMessageReq, bytes)
  } catch (error) {
    decoded = null
    console.warn('[MoChat] protobuf decode threw:', error)
  }

  // 历史数据兜底：早期入库的 payload_base64 是明文 UTF-8 字符串的 base64，
  // 没有走 protobuf 编码（早期手工 / 多媒体通道写入的数据）。protobufjs 对完全
  // 非 protobuf 字节有两种表现：抛异常，或者"部分解码"返回空 contents。两种情况
  // 都通过 contents 是否为空 + 内容类型是否齐全来判断是否走明文兜底。
  const contents = Array.isArray(decoded?.contents) ? (decoded!.contents as unknown[]) : []
  if (contents.length > 0 && hasRenderableContents(contents)) return decoded!

  // protobufjs failed — use manual protobuf field extraction
  const manualResult = manualExtractContents(bytes, kind)
  if (manualResult) return manualResult

  return { contents: [{ plainText: { text: '[无法解析的消息]' } }] }
}

function readVarint(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0
  let shift = 0
  while (offset < bytes.length) {
    const b = bytes[offset++]
    value |= (b & 0x7f) << shift
    if (!(b & 0x80)) break
    shift += 7
  }
  return [value, offset]
}

function manualExtractContents(bytes: Uint8Array, _kind: 'private' | 'group'): Record<string, unknown> | null {
  try {
    let offset = 0
    while (offset < bytes.length) {
      const [tagValue, nextOffset] = readVarint(bytes, offset)
      offset = nextOffset
      const fieldNumber = tagValue >>> 3
      const wireType = tagValue & 0x07
      if (wireType === 0) {
        const [, after] = readVarint(bytes, offset)
        offset = after
      } else if (wireType === 2) {
        const [len, dataStart] = readVarint(bytes, offset)
        if (fieldNumber === 10) {
          const msgBytes = bytes.subarray(dataStart, dataStart + len)
          const content = parseMessageContent(msgBytes)
          if (content) return { contents: [content] }
        }
        offset = dataStart + len
      } else if (wireType === 5) {
        offset += 4
      } else if (wireType === 1) {
        offset += 8
      } else {
        break
      }
    }
  } catch { /* manual parse failed */ }
  return null
}

function parseMessageContent(bytes: Uint8Array): Record<string, unknown> | null {
  let offset = 0
  while (offset < bytes.length) {
    const [tagValue, nextOffset] = readVarint(bytes, offset)
    offset = nextOffset
    const fieldNumber = tagValue >>> 3
    const wireType = tagValue & 0x07
    if (wireType === 2) {
      const [len, dataStart] = readVarint(bytes, offset)
      const fieldData = bytes.subarray(dataStart, dataStart + len)
      if (fieldNumber === 1) {
        const ciphertext = parseCiphertextFromEncryptedText(fieldData)
        if (ciphertext) {
          let binary = ''
          for (let i = 0; i < ciphertext.length; i++) binary += String.fromCharCode(ciphertext[i])
          return { encryptedText: { ciphertext: btoa(binary) }, content: 'encryptedText' }
        }
      } else if (fieldNumber === 2) {
        const text = parseStringField(fieldData, 1)
        if (text) return { plainText: { text }, content: 'plainText' }
      } else if (fieldNumber === 3) {
        const media = parseMediaMetadata(fieldData)
        if (media) return { media, content: 'media' }
      }
      offset = dataStart + len
    } else if (wireType === 0) {
      const [, after] = readVarint(bytes, offset)
      offset = after
    } else {
      break
    }
  }
  return null
}

function parseCiphertextFromEncryptedText(bytes: Uint8Array): Uint8Array | null {
  let offset = 0
  while (offset < bytes.length) {
    const [tagValue, nextOffset] = readVarint(bytes, offset)
    offset = nextOffset
    const fieldNumber = tagValue >>> 3
    const wireType = tagValue & 0x07
    if (wireType === 2) {
      const [len, dataStart] = readVarint(bytes, offset)
      if (fieldNumber === 2) return bytes.subarray(dataStart, dataStart + len)
      offset = dataStart + len
    } else if (wireType === 0) {
      const [, after] = readVarint(bytes, offset)
      offset = after
    } else {
      break
    }
  }
  return null
}

function parseStringField(bytes: Uint8Array, targetField: number): string | null {
  let offset = 0
  while (offset < bytes.length) {
    const [tagValue, nextOffset] = readVarint(bytes, offset)
    offset = nextOffset
    const fieldNumber = tagValue >>> 3
    const wireType = tagValue & 0x07
    if (wireType === 2) {
      const [len, dataStart] = readVarint(bytes, offset)
      if (fieldNumber === targetField) {
        return new TextDecoder().decode(bytes.subarray(dataStart, dataStart + len))
      }
      offset = dataStart + len
    } else if (wireType === 0) {
      const [, after] = readVarint(bytes, offset)
      offset = after
    } else {
      break
    }
  }
  return null
}

function parseMediaMetadata(bytes: Uint8Array): Record<string, unknown> | null {
  const result: Record<string, unknown> = {}
  let offset = 0
  while (offset < bytes.length) {
    const [tagValue, nextOffset] = readVarint(bytes, offset)
    offset = nextOffset
    const fieldNumber = tagValue >>> 3
    const wireType = tagValue & 0x07
    if (wireType === 2) {
      const [len, dataStart] = readVarint(bytes, offset)
      const str = new TextDecoder().decode(bytes.subarray(dataStart, dataStart + len))
      if (fieldNumber === 2) result.mediaUrl = str
      else if (fieldNumber === 3) result.thumbnailUrl = str
      else if (fieldNumber === 5) result.mimeType = str
      else if (fieldNumber === 6) result.fileName = str
      else if (fieldNumber === 10) result.previewText = str
      offset = dataStart + len
    } else if (wireType === 0) {
      const [value, after] = readVarint(bytes, offset)
      if (fieldNumber === 1) result.type = value
      else if (fieldNumber === 4) result.fileSize = value
      else if (fieldNumber === 7) result.duration = value
      else if (fieldNumber === 8) result.width = value
      else if (fieldNumber === 9) result.height = value
      offset = after
    } else if (wireType === 5) {
      offset += 4
    } else if (wireType === 1) {
      offset += 8
    } else {
      break
    }
  }
  if (result.mediaUrl || result.fileName || result.previewText) return result
  return null
}

// 仅在 contents 真的有可渲染内容（plainText/encryptedText/media 任一字段非空）时才视为成功解析。
function hasRenderableContents(contents: unknown[]): boolean {
  for (const content of contents) {
    if (!content || typeof content !== 'object') continue
    const record = content as Record<string, unknown>
    const plain = record.plainText as { text?: string } | undefined
    if (plain?.text) return true
    const encrypted = record.encryptedText as { nonce?: string; ciphertext?: string } | undefined
    if (encrypted?.ciphertext) return true
    const media = record.media as { mediaUrl?: string; fileName?: string; previewText?: string } | undefined
    if (media && (media.mediaUrl || media.fileName || media.previewText)) return true
  }
  return false
}


export function decodeRealtimeDelivery(payload: unknown) {
  const delivery = payload as ChatGatewayDelivery
  return normalizeDeliveryContents(delivery)
}

export function decodeSendAck(payload: unknown) {
  return payload as ChatGatewaySendAck
}

export function decodeDeliveredAck(payload: unknown) {
  return payload as ChatGatewayDeliveredAck
}

export function decodeErrorResponse(payload: unknown) {
  return payload as ChatGatewayError
}

function decodeCiphertextBytes(ciphertext: unknown): string {
  if (!ciphertext) return ''
  if (typeof ciphertext === 'string') {
    return new TextDecoder().decode(base64ToBytes(ciphertext))
  }
  if (ciphertext instanceof Uint8Array || ciphertext instanceof ArrayBuffer) {
    return new TextDecoder().decode(ciphertext)
  }
  if (typeof ciphertext === 'object' && ciphertext !== null) {
    const obj = ciphertext as Record<string, number>
    const keys = Object.keys(obj)
    if (keys.length > 0 && keys.every((k) => !Number.isNaN(Number(k)))) {
      const bytes = new Uint8Array(keys.length)
      for (let i = 0; i < keys.length; i++) bytes[i] = obj[String(i)]
      return new TextDecoder().decode(bytes)
    }
  }
  return String(ciphertext)
}

export function extractTextFromDecodedPayload(payload: Record<string, unknown>) {
  const contents = Array.isArray(payload.contents) ? payload.contents as Array<Record<string, unknown>> : []
  for (const content of contents) {
    const plain = content.plainText as { text?: string } | undefined
    if (plain?.text) return plain.text
    const encrypted = content.encryptedText as { ciphertext?: unknown } | undefined
    if (encrypted?.ciphertext) {
      try {
        return decodeCiphertextBytes(encrypted.ciphertext)
      } catch {
        return '[加密消息]'
      }
    }
    const media = content.media as { previewText?: string; fileName?: string; mediaUrl?: string } | undefined
    if (media) return media.previewText || media.fileName || media.mediaUrl || '[媒体消息]'
  }
  return ''
}

export function toHistoryDelivery(item: BackendHistoryItem, kind: 'private' | 'group'): ChatGatewayDelivery {
  const decoded = decodeHistoryItem(item, kind)
  const contents = (decoded.contents as ChatGatewayDelivery['contents']) ?? []
  const payload =
    kind === 'private'
      ? {
          toUid: typeof decoded.toUid === 'string' || typeof decoded.toUid === 'number' ? decoded.toUid : '0',
          privatePayload: {
            toUid: typeof decoded.toUid === 'string' || typeof decoded.toUid === 'number' ? decoded.toUid : '0',
            contents,
          },
        }
      : {
          groupId: typeof decoded.groupId === 'string' || typeof decoded.groupId === 'number' ? decoded.groupId : item.conversationId,
          groupPayload: {
            groupId: typeof decoded.groupId === 'string' || typeof decoded.groupId === 'number' ? decoded.groupId : item.conversationId,
            contents,
          },
        }
  return normalizeDeliveryContents({
    msgId: item.msgId,
    seq: item.seq,
    serverTimeMs: item.serverTimeMs,
    conversationId: item.conversationId,
    fromUid: item.senderUid !== undefined && item.senderUid !== null ? String(item.senderUid) : '0',
    contents,
    payloadType: kind === 'private' ? 'privatePayload' : 'groupPayload',
    ...payload,
  })
}

export function decodeStoredChatDelivery(base64: string) {
  return decodeMessage(ChatMessageDelivery, base64ToBytes(base64))
}

function normalizeDeliveryContents(delivery: ChatGatewayDelivery): ChatGatewayDelivery {
  if ((delivery.contents?.length ?? 0) > 0) return delivery
  if (delivery.privatePayload?.contents?.length) {
    return {
      ...delivery,
      contents: delivery.privatePayload.contents,
      toUid: delivery.toUid ?? delivery.privatePayload.toUid,
      payloadType: delivery.payloadType ?? 'privatePayload',
    }
  }
  if (delivery.groupPayload?.contents?.length) {
    return {
      ...delivery,
      contents: delivery.groupPayload.contents,
      groupId: delivery.groupId ?? delivery.groupPayload.groupId,
      payloadType: delivery.payloadType ?? 'groupPayload',
    }
  }
  return delivery
}
