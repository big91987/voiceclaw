# VoiceClaw

语音对话调试工具。链路：麦克风 → 火山 ASR → OpenClaw voice agent → 火山 TTS，支持实时播放和 Barge-in 打断。

## 架构

```
浏览器
  └─ WebSocket /ws/phase2-claw
        └─ src/test-page.ts (port 3017)
              ├─ 火山 ASR (wss://openspeech.bytedance.com)
              ├─ test-server.ts (port 3456)  ← proxy 模式
              │     └─ OpenClaw Gateway (ws://127.0.0.1:18789)
              └─ 火山 TTS (wss://openspeech.bytedance.com)
```

## 启动

```bash
npm install

# 终端 1：主服务（页面 + ASR/TTS）
npx ts-node src/test-page.ts

# 终端 2：Gateway proxy
npx ts-node test-server.ts
```

访问 http://127.0.0.1:3017/lobster

## 前置条件

需要 OpenClaw 设备认证文件，路径：`~/.openclaw/voiceclaw-device.json`

```json
{
  "version": 1,
  "deviceId": "...",
  "publicKeyPem": "...",
  "privateKeyPem": "..."
}
```

## 页面说明

| 字段 | 说明 |
|------|------|
| Proxy URL | test-server.ts 地址，默认 `http://127.0.0.1:3456` |
| Agent ID | OpenClaw agent 名称，默认 `voice` |
| 启用 Barge-in | 说话时自动打断正在播放的 TTS |
| 复用 Session | 保留上下文，多轮对话 |

## 核心文件

```
src/test-page.ts       主服务：HTTP + WebSocket + ASR/TTS 管道
test-server.ts         Gateway proxy：转发消息到 OpenClaw，SSE 流式返回
src/config.ts          配置（从 .env 读取）
src/types.ts           类型定义
src/asr/AsrClient.ts   火山 ASR 客户端（供 src/index.ts 使用）
src/tts/TtsClient.ts   豆包 TTS 2.0 客户端（供 src/index.ts 使用）
```

## 环境变量（.env）

```
# ASR
ASR_API_KEY=
ASR_APP_ID=

# TTS
TTS_API_KEY=
TTS_APP_ID=

# OpenClaw Gateway
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=
```
