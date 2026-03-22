# VoiceClaw

语音对话 App，对接 OpenClaw Gateway。链路：浏览器麦克风 → 火山 ASR → OpenClaw Agent → 火山 TTS，支持多轮对话、实时流式回复、Barge-in 打断。

## 架构

```
浏览器 (localhost:3100)
  ├─ WebSocket /ws/asr          ← 浏览器推送 PCM 音频
  │     └─ app-server.ts
  │           ├─ 火山 ASR (wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async)
  │           │     └─ VAD + 断句检测，definite utterance → onFinal
  │           ├─ 火山 TTS (wss://openspeech.bytedance.com/api/v3/tts/bidirection)
  │           └─ OpenClaw Gateway (ws://127.0.0.1:18789)
  │                 └─ src/gateway-client.ts (shared WS, Ed25519 auth)
  │
  ├─ GET  /api/agents           ← 列出 agents
  ├─ GET  /api/sessions         ← 列出 sessions
  ├─ POST /api/chat             ← SSE 流式回复
  ├─ POST /api/chat/abort       ← 打断当前 run
  ├─ POST /api/tts              ← TTS 合成 MP3
  └─ GET  /api/events           ← 永久 SSE，转发 Gateway 事件
```

## 启动

```bash
npm install

# 确保 OpenClaw Gateway 已运行（默认 ws://127.0.0.1:18789）
# 确保设备已 pair（见下方前置条件）

npx ts-node app-server.ts
```

访问 http://localhost:3100

## 前置条件

需要通过 `openclaw` CLI 完成设备注册：

```bash
openclaw pair   # 首次配对，写入 ~/.openclaw/identity/device.json
```

配对后自动生成：
- `~/.openclaw/identity/device.json` — Ed25519 密钥对 + deviceId
- `~/.openclaw/devices/paired.json` — Gateway 颁发的 operator token

无需手动填写 token，`gateway-client.ts` 会自动读取。

## 核心文件

```
app-server.ts              主服务（port 3100）：HTTP + WS/ASR + TTS + Gateway 代理
src/gateway-client.ts      OpenClaw Gateway WS 客户端（Ed25519 认证，自动重连）
src/config.ts              配置（从 .env 读取 ASR/TTS key）
src/app/
  index.html               页面骨架
  main.js                  入口，串联各模块
  voice.js                 浏览器端 ASR WebSocket + TTS 播放 + 通话模式
  api.js                   fetch 封装（streamChat / abortChat / fetchAgents）
  ui-agents.js             Agent 下拉选择器
  ui-sessions.js           Session 下拉选择器（含新建/切换）
  ui-chat.js               对话消息列表渲染
  ui-tasks.js              任务面板（从 Gateway 事件更新）
  ui-settings.js           设置面板（OpenClaw 配置路径）
  style.css                样式
```

## 通话模式（Call Mode）

点击 📞 按钮进入通话模式：

1. 浏览器通过 WebSocket 持续推送 PCM 16kHz 音频到 `/ws/asr`
2. 服务端连接火山 `bigmodel_async` ASR，VAD 检测断句（`end_window_size: 800ms`）
3. ByteDance 返回 `definite=true` utterance → 触发 `onFinal` → 发送到 OpenClaw Gateway
4. Gateway 流式返回文字 → SSE → 浏览器渲染 + TTS 合成播放
5. **Barge-in**：新 utterance 到来时，若上一轮 TTS 正在播放，触发 `barge_in`：
   - 停止当前 TTS（`stopSpeaking()`）
   - 发送 `POST /api/chat/abort` → Gateway `chat.abort` → 中止 agent run
   - 开始新一轮

## Gateway 认证流程

```
首次连接：
  app-server.ts 读取 ~/.openclaw/identity/device.json
  → 发送 metadata（deviceId + publicKey + platform=darwin）
  → Gateway 返回 challenge
  → 用 Ed25519 私钥签名 → 发送 signature
  → Gateway 验证通过 → 连接建立

复用连接：
  检查 gatewayClient.isConnected() → 直接复用
  Gateway 重启后 WS close → gatewayReady=false → 下次请求自动重连
```

## 环境变量（.env）

```
# 火山 ASR
ASR_API_KEY=
ASR_APP_ID=

# 火山 TTS
TTS_API_KEY=
TTS_APP_ID=

# OpenClaw Gateway（可选，默认读 paired.json）
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=    # 不填则从 ~/.openclaw/devices/paired.json 自动读取
```
