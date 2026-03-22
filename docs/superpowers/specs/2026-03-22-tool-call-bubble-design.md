# 工具调用气泡 UI 设计

**日期：** 2026-03-22
**状态：** 待实现

---

## 背景

VoiceClaw 对话界面（`src/app/`）目前只渲染 `assistant` 文字流，当 agent 调用工具时（`payload.stream === 'tool'`），前端没有任何反馈。用户无法感知 agent 正在做什么，体验空白。

Gateway 已经通过全局 SSE（`/api/events`）实时推送工具调用事件，前端 `api.js` 也已经把它 emit 为 `agent-event`，但 `ui-tasks.js` 里只处理了 `lifecycle`，tool 事件被忽略。

---

## 目标

在对话消息列表（`#messages`）里实时插入工具调用折叠气泡：

- `phase: start` 时创建气泡，显示工具名 + 黄色状态点 + "运行中…"
- `phase: result` 时更新同一气泡，变为绿色状态点 + "完成"，详情可手动点击展开
- 每个工具调用各自独立一个气泡
- TTS 不念工具调用内容（工具气泡不进入 `speak()` 流程，天然隔离）
- 手动点击展开详情，不自动展开

---

## 事件结构

Gateway 推送的 `agent` 事件，`payload.stream === 'tool'` 时：

```json
{
  "event": "agent",
  "payload": {
    "runId": "xxx",
    "sessionKey": "agent:voice:...",
    "stream": "tool",
    "data": {
      "toolCallId": "toolu_01abc",
      "name": "get_weather",
      "phase": "start" | "update" | "result",
      "args": { "city": "北京" },
      "result": "晴，12°C，东风2级"
    }
  }
}
```

关键字段：
- `toolCallId`：唯一标识一次工具调用，用于关联 start → result
- `phase: update`：流式中间结果，可选处理，本次设计忽略（只处理 start/result）

---

## 设计决策

| 问题 | 决策 |
|------|------|
| 展示位置 | `#messages` 消息列表，与 user/assistant 气泡同列 |
| 样式风格 | 折叠式（选项 C）：默认折叠，手动点击展开 |
| 多工具调用 | 每个独立一个气泡，不合并 |
| 完成后是否自动展开 | 否，始终手动 |
| TTS | 工具气泡不参与 TTS，天然隔离 |
| 数据来源 | 全局 SSE 事件总线（`/api/events` → `agent-event`），不走 `streamChat` |

---

## 实现方案

**改动范围：2 个文件**

### 1. `src/app/ui-tasks.js`

新增 `on('agent-event', ...)` 分支处理 `stream === 'tool'`：

```
收到 phase: start
  → 在 #messages 末尾插入折叠气泡 DOM
  → 以 toolCallId 为 key 缓存 DOM 引用（Map）

收到 phase: result
  → 查找缓存的 DOM 元素
  → 更新状态点颜色（黄→绿）、文字（运行中→完成）
  → 将 args + result 写入隐藏的详情区域
  → 绑定点击展开/折叠事件
```

气泡 DOM 结构：
```html
<div class="msg msg--tool" data-tool-call-id="toolu_01abc">
  <div class="tool-summary">
    <div class="tool-dot running"></div>
    <span class="tool-name">get_weather</span>
    <span class="tool-status">运行中…</span>
  </div>
  <div class="tool-detail" hidden>
    <div class="tool-detail-args">...</div>
    <div class="tool-detail-result">...</div>
  </div>
</div>
```

点击 `.tool-summary` 切换 `.tool-detail` 的 `hidden` 属性。

### 2. `src/app/style.css`

新增 `.msg--tool` 及相关子元素样式：

```css
.msg--tool {
  /* 折叠容器：无背景边框，左对齐 */
  align-self: flex-start;
  background: #242424;
  border: 1px solid #3a3a3a;
  border-radius: 8px;
  max-width: 80%;
  overflow: hidden;
  font-size: 13px;
  cursor: default;
}
.tool-summary {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; color: #bbb; cursor: pointer;
}
.tool-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
}
.tool-dot.running { background: #f9c74f; }
.tool-dot.done    { background: #52c878; }
.tool-name  { color: #c8a0ff; font-weight: 500; }
.tool-status { color: #666; font-size: 11px; }
.tool-detail {
  border-top: 1px solid #333;
  padding: 8px 12px;
  background: #1a1a1a;
  color: #888;
  font-family: monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
}
.tool-detail-result { color: #52c878; margin-top: 4px; }
```

---

## 边界情况

- **result 先于 start 到达**：不处理（实践中不会发生）
- **phase: update**：忽略，只处理 start/result
- **toolCallId 缺失**：跳过，不插入气泡
- **详情内容过长**：依赖 `white-space: pre-wrap` + `word-break: break-all` 自动换行，不截断
- **页面刷新**：历史工具调用不重放（实时事件，不持久化）
- **sessionKey 过滤**：不过滤，显示当前 gateway 连接收到的所有 tool 事件（与现有 lifecycle 处理一致）

---

## 不在范围内

- `phase: update` 的流式进度展示
- 点击工具气泡跳转到相关消息
- 工具调用历史持久化
- 工具调用结果的格式化（JSON pretty print 等）
