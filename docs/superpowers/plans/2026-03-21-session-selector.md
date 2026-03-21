# Session Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 下拉框选择已有 session 或新建 session，切换后下一条消息路由到所选 session。

**Scope:**
- 本次实现：session 下拉框 UI，切换后路由下一条消息到所选 session
- 后续：加载历史消息（需 gateway 提供 history API，属独立任务）

**Architecture:**
- 新建 `src/app/ui-sessions.js` — session 下拉框组件，调用 `fetchSessions` API
- 修改 `src/app/main.js` — 渲染 session selector；切换 session 时更新全局 sessionKey；发送时把选中的 sessionKey 传入 `sendMessage`
- 修改 `src/app/api.js` — `streamChat` 传入 `sessionKey` 参数时，gateway 会路由到该 session（`reuseSession: true` 时优先用传入的 sessionKey）
- 注意：`lastMessagePreview` gateway 不返回，下拉框只显示 session key（取后缀部分）

**Tech Stack:** Vanilla JS ES Modules, CSS

---

## 文件清单

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/app/ui-sessions.js` | 新建 | session 下拉框 UI |
| `src/app/main.js` | 修改 | 渲染 selector，session 状态管理 |
| `src/app/api.js` | 修改 | `fetchSessions` 暴露给 ui-sessions 调用（已存在） |
| `src/app/index.html` | 修改 | 在 agent-selector 旁加 session-selector 容器 |

---

## Task 1: 创建 ui-sessions.js 组件

**Files:**
- Create: `src/app/ui-sessions.js`

```javascript
// src/app/ui-sessions.js — session selector dropdown
import { fetchSessions } from './api.js';

let onChangeCallback = null;
let currentSessionKey = null;
let currentAgentId = null;

export function initSessionSelector(containerId, agentId, onChange) {
  currentAgentId = agentId;
  onChangeCallback = onChange;
  const container = document.getElementById(containerId);
  container.innerHTML = `
    <select id="session-select">
      <option value="__new__">+ 新建 session</option>
    </select>
  `;
  const sel = container.querySelector('select');
  sel.addEventListener('change', () => {
    const value = sel.value;
    if (value === '__new__') {
      currentSessionKey = null;
      onChangeCallback?.(null);
    } else {
      currentSessionKey = value;
      onChangeCallback?.(value);
    }
  });
  loadSessions(agentId);
}

export async function refreshSessions(agentId) {
  currentAgentId = agentId;
  const container = document.getElementById('session-selector');
  const sel = container?.querySelector('select');
  if (!sel) return;
  await loadSessions(agentId, sel);
}

async function loadSessions(agentId, sel) {
  sel = sel || document.getElementById('session-select');
  if (!sel) return;
  try {
    const data = await fetchSessions(agentId);
    const sessions = data?.sessions || [];
    // Build options: top is always "+ 新建 session"
    const newOpt = '<option value="__new__">+ 新建 session</option>';
    if (sessions.length === 0) {
      sel.innerHTML = newOpt;
      return;
    }
    const sessionOpts = sessions.map(s => {
      // session key 形如 agent:voice:web-sticky-xxx，取后半部分更可读
      const label = s.key.split(':').slice(-2).join(':');
      return `<option value="${s.key}">${label}</option>`;
    }).join('');
    sel.innerHTML = newOpt + sessionOpts;
  } catch {
    sel.innerHTML = newOpt;
  }
}

export function getSessionKey() { return currentSessionKey; }

export function clearSessionKey() { currentSessionKey = null; }
```

- [ ] **Step 1: 创建 src/app/ui-sessions.js 文件**，内容如上

- [ ] **Step 2: 验证 API 调用**

Run: `curl -s "http://localhost:3100/api/sessions?agentId=voice" | python3 -c "import sys,json; d=json.load(sys.stdin); print('sessions count:', len(d.get('sessions',[])))"`
Expected: `sessions count: N` (N > 0)

---

## Task 2: 修改 index.html 加容器

**Files:**
- Modify: `src/app/index.html:14`

在 agent-selector 容器后面加一行：

```html
<div id="session-selector"></div>
```

- [ ] **Step 1: 修改 index.html**，在 `<div id="agent-selector"></div>` 后加 `<div id="session-selector"></div>`

---

## Task 3: 修改 main.js 接入 session selector

**Files:**
- Modify: `src/app/main.js:3-5`
- Modify: `src/app/main.js:15-19`

```javascript
// main.js 修改1: 新增 import
import { initSessionSelector, getSessionKey, clearSessionKey, refreshSessions } from './ui-sessions.js';

// main.js 修改2: 替换 initAgentSelector 回调
initAgentSelector('agent-selector', async (id) => {
  clearSessionKey();           // 切换 agent 时清空 session
  initTasks(id);
  await refreshSessions(id);   // 刷新 session 列表
});

// main.js 修改3: 新增 initSessionSelector
initSessionSelector('session-selector', getAgentId(), (sessionKey) => {
  // sessionKey 为 null 表示新建 session，否则为选中的 sessionKey
  if (sessionKey === null) {
    // 新建 session：清空聊天区
    document.getElementById('messages').innerHTML = '';
  }
  // TODO: 选择已有 session 时加载历史（等 gateway 提供 history API）
});

// main.js 修改4: handleSend 中 sessionKey 传入
// 原来:
sessionKey: getCurrentSessionKey(),
// 改为:
sessionKey: getSessionKey() ?? getCurrentSessionKey(),
```

> **关键行为**: `getSessionKey()` 返回选中的 session key（来自下拉框），`null` 表示新建 session。传入 `streamChat` 时，`reuseSession: true` + 明确的 `sessionKey` 会把消息路由到该 session。

- [ ] **Step 1: 修改 main.js** 添加 import 和 initSessionSelector 调用

- [ ] **Step 2: 修改 handleSend**，sessionKey 优先用 `getSessionKey()`

- [ ] **Step 3: 修改 agent selector 回调**，加入 `refreshSessions`

---

## Task 4: 修改 sendMessage 支持明确 sessionKey

**Files:**
- Modify: `src/app/ui-chat.js:25`

当前 `sendMessage` 里 `streamChat` 传入的 `sessionKey` 来自参数。当前已支持直接传 `sessionKey`，不需要改 `ui-chat.js`。

需要确认 `streamChat` 不会在已有 `sessionKey` 时覆盖它。检查 `api.js`：

- [ ] **Step 1: 确认 api.js 的 `streamChat` 直接透传 sessionKey** — 已有 sessionKey 参数透传到 gateway，不被覆盖

Run: `grep -n "sessionKey" src/app/api.js`
Expected: `sessionKey` 从 `streamChat({..., sessionKey})` 透传到 `body: JSON.stringify({..., sessionKey, ...})`

---

## Task 5: 浏览器端到端测试

**Files:**
- Test: Playwright 脚本 `test-sessions.mjs`

- [ ] **Step 1: Playwright 测试 — 选已有 session 后发消息**

```javascript
// test-sessions.mjs
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:3100');
await page.waitForTimeout(2000);
await page.selectOption('#agent-select', 'voice');
await page.waitForTimeout(1000);
// 验证下拉框出现且有 "+ 新建 session" 选项
const opts = await page.$$eval('#session-select option', els => els.map(o => o.value));
console.log('session options:', opts);
console.log('has __new__:', opts.includes('__new__'));
// 如果有 session 选项，选第一个（不是 __new__）
const sessionOpts = opts.filter(o => o !== '__new__');
if (sessionOpts.length > 0) {
  await page.selectOption('#session-select', sessionOpts[0]);
  await page.fill('#text-input', 'continue this session');
  await page.click('#btn-send');
  await page.waitForTimeout(8000);
  const msgs = await page.$$eval('.msg', els => els.map(e => e.textContent.slice(0,50)));
  console.log('messages after selecting existing session:', msgs);
}
await browser.close();
```

Run: `node test-sessions.mjs`
Expected: 页面正常渲染，下拉框有选项

- [ ] **Step 2: 提交代码**

```bash
git add src/app/ui-sessions.js src/app/main.js src/app/index.html
git commit -m "feat: add session selector dropdown"
```

---

## 验收标准

- [ ] 切换 agent 后，session 下拉框显示该 agent 的 session 列表
- [ ] 选择已有 session，下拉框值变为该 session key
- [ ] 选择"新建 session"，下拉框值变为 __new__（内部处理为 null）
- [ ] 选完 session 后发消息，消息被路由到所选 session（gateway 层面）
- [ ] 无 session 时，下拉框只有"+ 新建 session"
- [ ] 网络失败不崩溃，只显示"+ 新建 session"

## 后续任务（不在本 plan 范围）

- 加载历史消息：需要 gateway 提供 `/api/chat/history?sessionKey=xxx` 接口，属独立任务
