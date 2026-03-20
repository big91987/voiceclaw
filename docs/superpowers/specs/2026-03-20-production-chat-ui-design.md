# Production Chat UI — Design Spec

**Date:** 2026-03-20
**Project:** voiceclaw_cc
**Status:** Approved

---

## Overview

新增一个生产级对话界面 `/app`，替代原有调试页面作为日常使用入口。支持语音/文字输入、全双工通话模式、Agent 选择、以及 Agent 任务看板。原有 `/lobster` 和 `/para` 页面保留作调试用。

---

## Architecture

### 整体链路

```
Browser /app
  └── ES Modules (src/app/)
        ├── api.js        ← 统一数据层：REST + 永久 SSE
        ├── voice.js      ← ASR/TTS 管道
        ├── ui-chat.js    ← 对话 UI
        ├── ui-tasks.js   ← 任务看板
        ├── ui-agents.js  ← Agent 选择器
        └── main.js       ← 组装入口

test-server.ts（新增端点）
  ├── GET  /app/*          ← 静态文件 serve src/app/
  ├── GET  /api/events     ← 永久 SSE，转发所有 gateway 事件
  └── GET  /api/sessions   ← 代理 sessions.list（?agentId=）

OpenClaw Gateway (ws://127.0.0.1:18789)
  ├── sessions.list        ← 任务列表初始拉取
  ├── agents.list          ← Agent 列表（已有）
  └── agent events         ← 实时广播（lifecycle/assistant/tool）
```

### 模块职责

| 模块 | 职责 |
|------|------|
| `api.js` | 单一数据源。管理 `/api/events` SSE 连接，暴露事件总线 `on('agent-event', fn)`；封装 REST 调用 |
| `voice.js` | ByteDance ASR + TTS 管道，从 test-page.ts 提取复用。暴露 `startListening()` / `stopListening()` / `speak(text)` / `stopSpeaking()` |
| `ui-chat.js` | 对话消息渲染，调 `/api/chat` SSE 流，处理 assistant 文字增量输出 |
| `ui-tasks.js` | 任务看板渲染，订阅 `api.js` 事件总线，维护 session 树状态 |
| `ui-agents.js` | Agent 下拉选择器，调 `/api/agents` |
| `main.js` | 入口，初始化各模块，绑定全局状态（当前 agentId、输入模式） |

---

## UI Layout

```
┌─────────────────────────────────────────────────────┐
│  [● voice]  OpenClaw  [Agent: voice ▼]   [任务 ▶]   │  ← header
├──────────────────────────────────┬──────────────────┤
│                                  │  任务看板         │
│                                  │  ──────────────  │
│   🤖 你好，有什么可以帮你？       │  ▼ 当前对话       │
│                                  │    ⚡ running     │
│   👤 帮我查一下天气              │    └─ subagent    │
│                                  │       ✓ done     │
│   🤖 正在查询...                 │  ──────────────  │
│                                  │  ▼ 历史任务       │
│                                  │    ✓ 昨天的任务   │
├──────────────────────────────────┴──────────────────┤
│  [🎤] [输入消息，或点麦克风听写___________] [↑] [📞] │
└─────────────────────────────────────────────────────┘
```

**通话模式**（点击 📞 后，输入栏区域替换为）：

```
┌─────────────────────────────────────────────────────┐
│         ~~~~ 你的波形 ~~~~  ~~~~ Agent 波形 ~~~~     │
│                      [ 🔴 挂断 ]                    │
└─────────────────────────────────────────────────────┘
```

---

## Input Bar 交互

两种状态：

### 普通状态
- **左侧麦克风图标**：点击开始听写，语音转文字填入输入框，用户确认后手动发送（半双工听写）
- **文字输入框**：标准输入，Enter 或点发送按钮发送
- **右侧 📞 通话按钮**：进入全双工通话模式

### 通话模式
- 输入栏整体替换为双波形 + 挂断按钮
- 全双工：麦克风持续开启，ASR 实时运行
- Barge-in：ASR 检测到用户说话 → 停止 TTS + 发 `queueMode: interrupt` 给 Agent
- 挂断：停止 ASR/TTS，恢复普通输入栏
- **回声抑制**：TTS 播放期间提高 VAD 阈值，避免播放音被误识别

---

## Task Board

### 数据流

```
1. 初始化：GET /api/sessions?agentId=<id>
   → sessions.list 返回所有 session 行
   → 按 spawnedBy 字段组装树结构
   → key 含 "subagent:" 标识子 agent

2. 实时更新：订阅 /api/events SSE
   → agent event, stream: "lifecycle", phase: "start"  → 节点标记 running
   → agent event, stream: "lifecycle", phase: "end"    → 节点标记 done
   → agent event, stream: "lifecycle", phase: "error"  → 节点标记 error
   → 出现未知 sessionKey → 触发重新拉取 sessions.list
```

### Session 树结构

```
主对话 (agent:voice:web-xxx)          ← kind: direct/group
  └─ subagent (agent:voice:subagent:xxx)  ← spawnedBy 指向父
       └─ 更深层 subagent              ← getSubagentDepth() 计算层数
```

### 状态标记

| 状态 | 触发条件 |
|------|---------|
| `running` ⚡ | lifecycle phase=start |
| `done` ✓ | lifecycle phase=end |
| `error` ✗ | lifecycle phase=error |
| `aborted` ↩ | abortedLastRun=true（来自 sessions.list） |
| `idle` — | 有历史但当前无 run |

---

## File Structure

```
src/app/
  index.html       ← 入口 HTML，引入 main.js (type="module")
  main.js          ← 初始化、全局状态
  api.js           ← REST + SSE 数据层
  voice.js         ← ASR/TTS 管道
  ui-chat.js       ← 对话消息渲染
  ui-tasks.js      ← 任务看板
  ui-agents.js     ← Agent 选择器
  style.css        ← 全局样式

test-server.ts     ← 新增 /app/* 静态 serve + /api/events + /api/sessions
```

---

## test-server.ts 新增端点

### `GET /api/events`
永久 SSE 连接。将全局 `GatewayClient` 收到的所有事件转发给前端。客户端断开时自动清理 listener。

### `GET /api/sessions`
参数：`?agentId=voice`（可选）。调用 gateway `sessions.list` 方法，返回 JSON。

### `GET /app/*`
静态文件服务，serve `src/app/` 目录。

---

## 不在本期范围

- React/Vite 迁移（后续）
- 任务看板的手动 abort（调 `chat.abort` — 后续）
- 多 Agent 同时监控（后续）
- 移动端适配（后续）
