# MoChat Desktop

MoChat 的跨平台桌面客户端，基于 Electron、React、TypeScript 与 Vite，支持 macOS 和 Windows。

## 功能

- 用户名登录/注册，本地生成身份公钥
- 深色三栏 IM 界面，会话搜索与未读状态
- 私聊/群聊消息展示与发送、附件选择
- 联系人、群组、好友申请和客户端设置
- 语音/视频通话入口及 WebSocket 信令适配
- REST API 适配与后端不可用时的演示模式
- Electron 上下文隔离、沙箱和外链安全处理
- macOS DMG/ZIP 与 Windows NSIS/Portable 打包

## 开发

```bash
npm install
cp .env.example .env
npm run dev
```

仅启动浏览器版本用于界面调试：

```bash
npm run dev:web
```

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:8080` | REST API 地址 |
| `VITE_CALL_WS_URL` | `ws://localhost:8080` | 通话信令地址 |
| `VITE_DEMO_MODE` | `true` | 后端不可用时启用演示模式 |

应用内的“设置 > 连接”可覆盖 REST API 地址。

## 验证与打包

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run dist:mac
npm run dist:win
```

Windows 安装包建议由 Windows 或 GitHub Actions 构建；macOS 同理。CI 会在两个系统上分别产出可下载制品。

## 后端协议

REST API、WebSocket 和 TCP/Protobuf 契约来自 [`LystranG/mo-chat`](https://github.com/LystranG/mo-chat/tree/dev-cloud)。客户端 REST 入口位于 `src/api.ts`，通话信令由 `CallSignaling` 封装。当前服务端的聊天消息主链路是 TCP/Protobuf；界面层已为后续长连接适配保留消息状态模型。
