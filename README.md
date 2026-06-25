# MoChat Desktop

MoChat 的跨平台桌面客户端，基于 Electron、React、TypeScript 与 Vite，支持 macOS 和 Windows。

## 功能

- 用户名登录/注册，本地生成身份公钥
- 深色三栏 IM 界面，会话搜索与未读状态
- 私聊/群聊消息展示与发送、附件选择
- 媒体文件上传，并按后端多媒体消息接口发送图片/音频/视频/文件消息
- 联系人、群组、好友申请和客户端设置
- 语音/视频通话入口、Call Service 信令和 LiveKit token 入房适配
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
| `VITE_API_BASE_URL` | `http://103.40.14.14:57675` | api-service REST 地址 |
| `VITE_CALL_BASE_URL` | `http://103.40.14.14:24478` | call-service REST 地址 |
| `VITE_CALL_WS_URL` | `ws://103.40.14.14:24478` | call-service WebSocket 地址 |
| `VITE_MEDIA_BASE_URL` | `http://114.66.28.185:20216` | multimedia-service REST 地址 |
| `VITE_CHAT_GATEWAY_URL` | `tls://103.40.14.14:20823` | access-gateway IM TCP/TLS 地址（聊天长连接） |
| `VITE_DEMO_MODE` | `true` | 后端不可用时启用演示模式 |

应用内的“设置 > 连接”可覆盖 API、Call 和 Media 服务地址。

LiveKit API key/secret 只配置在后端 `call-service`，前端只使用 `/calls/**` 返回的 `token` 和 `livekitUrl`。本地调通通话链路时，在后端环境中设置：

```bash
export MOCHAT_LIVEKIT_URL=wss://easy-chat-xgexhw94.livekit.cloud
export MOCHAT_LIVEKIT_API_KEY=<your-key>
export MOCHAT_LIVEKIT_API_SECRET=<your-secret>
```

## 验证与打包

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run dist:mac
npm run dist:win
```

安装包和解压后的应用统一输出到 `dist/`。`dist:mac` 生成 Apple Silicon (`arm64`) 版本，`dist:win` 生成适用于主流 Windows 电脑的 `x64` 版本；也可以在 macOS 上交叉生成 Windows 安装包。

Windows 安装包建议由 Windows 或 GitHub Actions 构建；macOS 同理。CI 会在两个系统上分别产出可下载制品。

## 后端协议

REST API、WebSocket 和 TCP/Protobuf 契约来自 [`LystranG/mo-chat`](https://github.com/LystranG/mo-chat/tree/dev-cloud)。客户端 REST 入口位于 `src/api.ts`，通话信令由 `CallSignaling` 封装。当前文本聊天主链路仍是 TCP/Protobuf；多媒体消息走后端新增的 `/media/upload` 与 `/messages/send-multimedia/*` HTTP 接口。
