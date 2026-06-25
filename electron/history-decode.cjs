// 把 history 里 payloadBase64（PrivateMessageReq / GroupMessageReq 的 protobuf bytes）
// 还原成普通对象，主进程在解密私聊历史时需要摘出 contents[0].encryptedText.nonce/ciphertext。
// 私聊 ECDH 共享密钥对一次会话是固定的；解密失败时上层兜底显示 [加密消息]。

const protobuf = require('protobufjs')

const proto = `
syntax = "proto3";
package mochat.v1;

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

function base64ToBytes(base64) {
  const binary = Buffer.from(base64, 'base64')
  return new Uint8Array(binary)
}

function decodeHistoryItem(payloadBase64, kind) {
  const type = kind === 'group' ? GroupMessageReq : PrivateMessageReq
  return type.toObject(type.decode(base64ToBytes(payloadBase64)), {
    longs: String,
    enums: String,
    bytes: String,
    oneofs: true,
    defaults: false,
    arrays: true,
  })
}

module.exports = { decodeHistoryItem }