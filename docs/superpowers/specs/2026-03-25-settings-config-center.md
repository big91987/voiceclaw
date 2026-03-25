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
| `callQueueMode` | `"interrupt" \| "queue"` | `"interrupt"` | How new voice input is handled when agent is busy — **voice call path only**, not text chat |

All settings are global (apply to all agents).

Toggling a setting takes effect on the **next message** — existing bubbles in the current view are not removed.

---

## Bug Fixes

### 1. Thinking blocks in session history

**Problem:** `loadHistory` in `ui-chat.js` silently skips `type: "thinking"` content blocks with `// skip 'thinking' blocks`.

**Fix:** Handle `block.type === 'thinking'` — call `appendStaticThinkingBubble(text)` if `getSetting('showThinking')` is true.

The thinking text field must be read defensively (Anthropic API shape uses `block.thinking`, some providers normalize to `block.text`):

```js
} else if (block.type === 'thinking') {
  const text = block.thinking || block.text;
  if (text && getSetting('showThinking')) appendStaticThinkingBubble(text);
}
```

`appendStaticThinkingBubble(text)` added to `ui-tasks.js`: creates a done-state, collapsed thinking bubble (same visual as a finalized live bubble). Appended to `#messages`.

### 2. Thinking bubble lifecycle

**Problem:** When an agent turn has multiple thinking phases (e.g. initial reasoning → tool call → more reasoning), new thinking events update the same bubble instead of starting a fresh one.

**Fix:** Extract a `finalizeThinkingBubble(tb)` helper in `ui-chat.js` (replaces the three inline finalization patterns already in the file):

```js
function finalizeThinkingBubble(tb) {
  tb.dot.className = 'tool-dot done';
  tb.nameEl.textContent = '已思考';
}
```

Then in the `thinking` stream handler, finalize the existing bubble before creating a new one:

```js
if (event.payload?.stream === 'thinking') {
  if (thinkingBubble) { finalizeThinkingBubble(thinkingBubble); thinkingBubble = null; }
  const tb = getOrCreateThinkingBubble();
  // update tb content
}
```

All three existing inline finalization sites (assistant text start, tool-call start, stream end) must also be updated to use the helper.

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

## Implementation Notes

- `showToolCalls` setting guards bubble creation at the `phase === 'start'` branch entry point in both the live stream handler and `appendStaticToolBubble`. Affects both live and history tool bubbles.
- `showThinking` setting guards both the live thinking stream handler and `appendStaticThinkingBubble` in `loadHistory`.
- Each new toggle/select in `ui-settings.js` must be initialized from `getSetting` on load (not just left unchecked), and wired to `setSetting` on `change`.
- `callQueueMode` only replaces the hardcoded `'interrupt'` in `main.js` line ~221 (the voice call `streamChat` call), not the text chat path.

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
