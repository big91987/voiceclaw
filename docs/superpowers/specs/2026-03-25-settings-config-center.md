# Settings Config Center

**Date:** 2026-03-25
**Status:** Approved

## Overview

Add a lightweight runtime config center (`settings.js`) as the single source of truth for user preferences. Expose three settings in the UI settings panel, and fix two related bugs in the thinking bubble display.

## Goals

1. Centralized, persistent config store that any module can read from
2. Three new user-facing settings: show thinking, show tool calls, call queue mode
3. Fix: thinking blocks missing from session history on re-load
4. Fix: thinking bubble lifecycle — new thinking phase should finalize the previous bubble

## Non-Goals

- Per-agent settings (global only for now)
- Server-side persistence (localStorage is sufficient)
- Changing what data is transmitted (`reasoningLevel: 'stream'` stays always-on)

---

## Architecture

```
settings.js          ← new: pure storage module (localStorage)
ui-settings.js       ← renders controls, calls setSetting
ui-chat.js           ← imports getSetting, fixes history + lifecycle
ui-tasks.js          ← imports getSetting, adds appendStaticThinkingBubble
main.js              ← imports getSetting for callQueueMode
index.html           ← adds 3 setting controls
style.css            ← adds toggle switch styles
```

### settings.js

Single-responsibility module. No DOM dependencies.

```js
const DEFAULTS = {
  showThinking: true,
  showToolCalls: true,
  callQueueMode: 'interrupt',
};

export function getSetting(key) { ... }
export function setSetting(key, value) { ... }
```

Storage: `localStorage` with key prefix `vc_setting_`. Falls back to `DEFAULTS` if key not found.

---

## Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `showThinking` | boolean | `true` | Show/hide thinking bubbles in chat and history |
| `showToolCalls` | boolean | `true` | Show/hide tool call bubbles in chat and history |
| `callQueueMode` | `"interrupt" \| "queue"` | `"interrupt"` | How new voice input is handled when agent is busy |

All settings are global (apply to all agents).

Toggling a setting takes effect on the **next message** — existing bubbles in the current view are not removed.

---

## Bug Fixes

### 1. Thinking blocks in session history

**Problem:** `loadHistory` in `ui-chat.js` silently skips `type: "thinking"` content blocks with `// skip 'thinking' blocks`.

**Fix:** Handle `block.type === 'thinking'` — call `appendStaticThinkingBubble(block.thinking)` if `getSetting('showThinking')` is true.

`appendStaticThinkingBubble(text)` added to `ui-tasks.js`: creates a done-state, collapsed thinking bubble (same visual as a finalized live bubble). Appended to `#messages`.

### 2. Thinking bubble lifecycle

**Problem:** When an agent turn has multiple thinking phases (e.g. initial reasoning → tool call → more reasoning), new thinking events update the same bubble instead of starting a fresh one.

**Fix:** In `sendMessage`, before creating a new thinking bubble, always finalize the existing one:

```js
if (event.payload?.stream === 'thinking') {
  if (thinkingBubble) { finalize(thinkingBubble); thinkingBubble = null; }
  const tb = getOrCreateThinkingBubble();
  // update tb content
}
```

This ensures each reasoning phase gets its own bubble.

---

## UI

Settings panel gets two new groups:

**Display**
- Toggle: 显示思考过程 (`showThinking`)
- Toggle: 显示工具调用 (`showToolCalls`)

**通话**
- Select: 打断模式 (`callQueueMode`) — options: 打断 / 排队

Toggle styling: standard CSS toggle switch, matches existing dark theme.

---

## Data Flow

```
User toggles setting
  → setSetting(key, value) → localStorage
  → next message/call reads getSetting(key)
  → UI behavior changes
```

No re-rendering of existing messages on toggle change.

---

## Files Changed

| File | Change |
|------|--------|
| `src/app/settings.js` | New: config store |
| `src/app/ui-settings.js` | Add 3 controls, wire to setSetting |
| `src/app/index.html` | Add HTML for new controls |
| `src/app/style.css` | Add toggle switch styles |
| `src/app/ui-tasks.js` | Add `appendStaticThinkingBubble`, guard tool bubbles with getSetting |
| `src/app/ui-chat.js` | History thinking render, lifecycle fix, guard thinking bubbles with getSetting |
| `src/app/main.js` | Read `callQueueMode` from getSetting |
