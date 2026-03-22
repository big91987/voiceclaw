# 工具调用气泡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在对话消息列表里实时插入折叠式工具调用气泡，显示 agent 工具调用的过程和结果。

**Architecture:** 监听已有的全局 SSE 事件总线（`api.js` emit 的 `agent-event`），在 `ui-tasks.js` 里新增 tool stream 处理逻辑，用 `toolCallId` 作 Map key 关联 start → result，直接操作 `#messages` DOM 插入/更新气泡。

**Tech Stack:** 原生 JavaScript ES Modules，无外部依赖；CSS 变量复用现有 `style.css` 主题。

---

## 文件改动范围

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/app/style.css` | 修改 | 新增 `.msg--tool`、`.tool-summary`、`.tool-dot`、`.tool-name`、`.tool-status`、`.tool-detail`、`.tool-detail-args`、`.tool-detail-result` 样式 |
| `src/app/ui-tasks.js` | 修改 | 新增 `agent-event` tool stream 处理：创建气泡、更新气泡、点击展开 |

不涉及：`main.js`、`voice.js`、`ui-chat.js`、`app-server.ts`、`api.js`。

---

### Task 1: 添加工具调用气泡 CSS 样式

**Files:**
- Modify: `src/app/style.css`

- [ ] **Step 1: 在 style.css 末尾追加样式**

在文件末尾（`.hidden { display: none !important; }` 之后）添加：

```css
/* Tool call bubbles */
.msg--tool {
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
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  color: #bbb;
  cursor: pointer;
  user-select: none;
}
.tool-summary:hover { background: #2a2a2a; }
.tool-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.tool-dot.running { background: #f9c74f; }
.tool-dot.done    { background: #52c878; }
.tool-name   { color: #c8a0ff; font-weight: 500; }
.tool-status { color: #666; font-size: 11px; }
.tool-detail {
  border-top: 1px solid #333;
  padding: 8px 12px;
  background: #1a1a1a;
  color: #888;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
}
.tool-detail-args   { color: #888; }
.tool-detail-result { color: #52c878; margin-top: 4px; }
```

- [ ] **Step 2: 验证样式无语法错误**

打开浏览器 http://localhost:3100，打开 DevTools → Console，确认没有 CSS 解析错误。

- [ ] **Step 3: Commit**

```bash
cd /Users/zhaojiuzhou/work/voiceclaw_cc
git add src/app/style.css
git commit -m "feat: add tool call bubble CSS styles"
```

---

### Task 2: 在 ui-tasks.js 实现工具调用气泡逻辑

**Files:**
- Modify: `src/app/ui-tasks.js`

- [ ] **Step 1: 在文件顶部添加 toolCallMap 和 messagesEl 引用**

在 `ui-tasks.js` 现有变量声明区域（`const panel = ...` 等之后）添加：

```js
// tool call bubble state: toolCallId → DOM element
const toolCallMap = new Map();
const messagesEl = document.getElementById('messages');
```

- [ ] **Step 2: 新增 createToolBubble 函数**

在文件末尾，`render()` 函数之后添加：

```js
function createToolBubble(toolCallId, name) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg--tool';
  wrap.dataset.toolCallId = toolCallId;

  const summary = document.createElement('div');
  summary.className = 'tool-summary';

  const dot = document.createElement('div');
  dot.className = 'tool-dot running';

  const nameEl = document.createElement('span');
  nameEl.className = 'tool-name';
  nameEl.textContent = name;

  const status = document.createElement('span');
  status.className = 'tool-status';
  status.textContent = '运行中…';

  summary.append(dot, nameEl, status);

  const detail = document.createElement('div');
  detail.className = 'tool-detail';
  detail.hidden = true;

  summary.addEventListener('click', () => {
    detail.hidden = !detail.hidden;
  });

  wrap.append(summary, detail);
  return { wrap, dot, status, detail };
}
```

- [ ] **Step 3: 新增 on('agent-event') tool stream 处理**

在文件末尾，`createToolBubble` 之后添加。注意：`ui-tasks.js` 里已有一个 `on('agent-event', ...)` 处理 `lifecycle`，这里再注册一个是安全的——`on` 是事件总线，支持多个监听器，二者互不干扰。

```js
on('agent-event', (event) => {
  const payload = event.payload || {};
  if (payload.stream !== 'tool') return;

  const data = payload.data || {};
  const { toolCallId, name, phase, args, result } = data;
  if (!toolCallId) return;

  if (phase === 'start') {
    const els = createToolBubble(toolCallId, name);
    // 缓存 args（来自 start 事件），result 事件中可能不再携带
    toolCallMap.set(toolCallId, { ...els, cachedArgs: args });
    if (messagesEl) {
      messagesEl.appendChild(els.wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  } else if (phase === 'result') {
    const els = toolCallMap.get(toolCallId);
    if (!els) return;

    // 更新状态
    els.dot.className = 'tool-dot done';
    els.status.textContent = '完成 · 点击展开';

    // 填充详情（args 使用 start 时缓存的值，result 事件里可能没有）
    const argsText = els.cachedArgs !== undefined
      ? 'args: ' + JSON.stringify(els.cachedArgs, null, 2)
      : '';
    const resultText = result !== undefined
      ? '\nresult: ' + (typeof result === 'string' ? result : JSON.stringify(result, null, 2))
      : '';

    const argsDiv = document.createElement('div');
    argsDiv.className = 'tool-detail-args';
    argsDiv.textContent = argsText;

    const resultDiv = document.createElement('div');
    resultDiv.className = 'tool-detail-result';
    resultDiv.textContent = resultText;

    els.detail.append(argsDiv, resultDiv);
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;

    // 用完释放 map 引用，避免无限积累
    toolCallMap.delete(toolCallId);
  }
});
```

- [ ] **Step 4: 验证逻辑正确**

确认：
1. `on` 函数已从 `api.js` 导入（现有 `import { fetchSessions, on } from './api.js'` 已包含）
2. `toolCallMap` 在模块顶层声明（不在函数内），保证跨事件持久
3. `messagesEl` 在模块初始化时就能拿到（页面加载时 `#messages` 已存在）

- [ ] **Step 5: Commit**

```bash
cd /Users/zhaojiuzhou/work/voiceclaw_cc
git add src/app/ui-tasks.js
git commit -m "feat: show tool call bubbles in message list"
```

---

### Task 3: 手动验证

**Files:** 无改动，仅验证。

- [ ] **Step 1: 重启服务**

```bash
# 找到并终止旧进程
lsof -ti :3100 | xargs kill -9 2>/dev/null
cd /Users/zhaojiuzhou/work/voiceclaw_cc
npx ts-node app-server.ts &> /tmp/voiceclaw.log &
sleep 3 && cat /tmp/voiceclaw.log
# 预期: App server running at http://localhost:3100
```

- [ ] **Step 2: 浏览器硬刷新**

打开 http://localhost:3100，按 **Cmd+Shift+R** 强制刷新。

- [ ] **Step 3: 触发工具调用**

发送一条会触发工具调用的消息（如"帮我查一下当前时间"或任何需要工具的请求），观察：

1. 发送后消息列表里出现黄点 + 工具名 + "运行中…" 气泡
2. 工具完成后气泡变为绿点 + "完成 · 点击展开"
3. 点击气泡展开显示 args 和 result
4. 再次点击折叠
5. TTS 只念 assistant 回复，不念工具调用内容

- [ ] **Step 4: 验证多工具调用**

如果 agent 连续调用多个工具，确认每个工具独立出现一个气泡，互不干扰。
