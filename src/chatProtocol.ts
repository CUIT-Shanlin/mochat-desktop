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
    if (import.meta.env.DEV) {
      console.warn('MoChat history payload protobuf decode failed, fallback to plain text', { kind, error })
    }
  }

  // 历史数据兜底：早期入库的 payload_base64 是明文 UTF-8 字符串的 base64，
  // 没有走 protobuf 编码（早期手工 / 多媒体通道写入的数据）。protobufjs 对完全
  // 非 protobuf 字节有两种表现：抛异常，或者"部分解码"返回空 contents。两种情况
  // 都通过 contents 是否为空 + 内容类型是否齐全来判断是否走明文兜底。
  const contents = Array.isArray(decoded?.contents) ? (decoded!.contents as unknown[]) : []
  if (contents.length > 0 && hasRenderableContents(contents)) return decoded!
  // 兜底：从原始字节里尝试找出可读文本，**绝不**直接把 protobuf header 字节当 utf-8 输出。
  const fallback = extractReadableText(bytes)
  if (fallback) return { contents: [{ plainText: { text: fallback } }] }
  // 完全不可读：返回占位文本，避免 UI 出现 `\u0010�����3` 这种 protobuf header 字符。
  return { contents: [{ plainText: { text: '[无法解析的消息]' } }] }
}

// 仅在 contents 真的有可渲染内容（plainText/encryptedText/media 任一字段非空）时才视为成功解析。
// 部分 protobufjs 解码会返回 `contents: [{}]` 这种空对象，下面的判断会把它们当 fallback 处理。
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

// 从 raw bytes 中尽量提取可读文本。优先尝试严格 utf-8（fatal），失败就退到 printable ASCII 子串。
// 这样可以避免显示 `\u0010�����3 ����ڙ��� �������� R$ " 123456789012 tcp verify hello 2` 这种
// "protobuf header 字节 + 末尾明文" 的混合乱码——header 部分的二进制会被剥掉，只保留明文片段。
function extractReadableText(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  // 1. 严格 utf-8：合法明文会直接命中。
  try {
    const strict = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (strict.trim()) return strict
  } catch {
    // 非法 utf-8：继续往下走
  }
  // 2. 非严格 utf-8：保留明文段，但丢弃 U+FFFD 替换符。
  const lenient = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const cleaned = lenient.replace(/\uFFFD/g, '').trim()
  if (cleaned) return cleaned
  return ''
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

export function extractTextFromDecodedPayload(payload: Record<string, unknown>) {
  const contents = Array.isArray(payload.contents) ? payload.contents as Array<Record<string, unknown>> : []
  for (const content of contents) {
    const plain = content.plainText as { text?: string } | undefined
    if (plain?.text) return plain.text
    const encrypted = content.encryptedText as { ciphertext?: string } | undefined
    if (encrypted?.ciphertext) {
      try {
        return new TextDecoder().decode(base64ToBytes(encrypted.ciphertext))
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
    fromUid: '0',
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
