import type { ChatMessage, Conversation, FriendRequest } from './types'

export const conversations: Conversation[] = [
  { id: 20001, targetId: 10002, kind: 'private', name: '张三', initials: '张', color: '#5d75e9', preview: '明天下午去学校吗？', time: '12:30', unread: 2, online: true },
  { id: 20002, targetId: 10003, kind: 'private', name: '李四', initials: '李', color: '#329f88', preview: '[图片]', time: '11:45', unread: 0, online: true },
  { id: 20003, targetId: 10004, kind: 'private', name: '赵六', initials: '赵', color: '#8d63d6', preview: '收到，谢谢', time: '周三', unread: 0 },
  { id: 20004, targetId: 10086, kind: 'group', name: '产品研发群', initials: '研', color: '#d4834f', preview: '王老师：周五记得演示', time: '周二', unread: 5 },
  { id: 20005, targetId: 10087, kind: 'group', name: '寝室快乐群', initials: '寝', color: '#c65c82', preview: '今晚吃什么？', time: '周一', unread: 0 },
]

export const initialMessages: ChatMessage[] = [
  { id: 1, conversationId: 20001, fromMe: false, text: '你好！', time: '12:25' },
  { id: 2, conversationId: 20001, fromMe: true, text: '你好，有什么事吗？', time: '12:26', status: 'read' },
  { id: 3, conversationId: 20001, fromMe: false, text: '今天有空吗？一起去图书馆', time: '12:29' },
  { id: 4, conversationId: 20001, fromMe: true, text: '好啊，几点？', time: '12:31', status: 'read' },
  { id: 5, conversationId: 20002, fromMe: false, text: '给你看看今天拍的照片', time: '11:45' },
  { id: 6, conversationId: 20004, fromMe: false, text: '周五下午两点进行版本演示，大家记得参加。', time: '10:18' },
]

export const friendRequests: FriendRequest[] = [
  { id: 1, name: '陈晨', userId: 10009, message: '我们在软件工程课见过', status: 'pending' },
  { id: 2, name: '王晓', userId: 10012, message: '来自产品研发群', status: 'pending' },
]
