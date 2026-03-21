# Production Chat UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone production chat UI at port 3100 with voice/text input, full-duplex call mode, agent selector, and real-time task board.

**Architecture:** New `app-server.ts` (port 3100) serves static files from `src/app/` and proxies to OpenClaw gateway. Frontend uses native ES modules. `src/gateway-client.ts` is extracted from test-server.ts and shared. ASR/TTS remain server-side (proxied to ByteDance).

**Tech Stack:** TypeScript + ts-node (server), Vanilla JS ES modules (frontend), ByteDance ASR/TTS, OpenClaw Gateway WebSocket.

---

## File Map

**New files:**
- `src/gateway-client.ts` — GatewayClient class + device auth (extracted from test-server.ts)
- `app-server.ts` — standalone HTTP server port 3100
- `src/app/index.html` — entry HTML
- `src/app/style.css` — global styles
- `src/app/main.js` — initializer, global state (agentId, call mode)
- `src/app/api.js` — REST calls + `/api/events` SSE event bus
- `src/app/ui-agents.js` — agent selector dropdown
- `src/app/ui-chat.js` — conversation messages + streaming
- `src/app/ui-tasks.js` — task board sidebar (session tree)
- `src/app/voice.js` — ASR dictation mode + TTS playback + call mode waveforms

**Existing files (read-only reference):**
- `test-server.ts` — source for GatewayClient extraction
- `src/test-page.ts` — source for ASR/TTS logic extraction
- `src/config.ts` — config (ASR/TTS keys read from .env)

---

## Task 1: Extract `src/gateway-client.ts`

**Files:**
- Create: `src/gateway-client.ts`

- [ ] **Step 1: Read test-server.ts in full to identify all code that belongs in gateway-client**

  Run: `cat test-server.ts` — note the `DeviceIdentity` interface, `loadDeviceIdentity()`, `deriveDeviceId()`, `buildDeviceAuthPayload()`, `signData()`, and the full `GatewayClient` class (lines 21–248).

- [ ] **Step 2: Create `src/gateway-client.ts` with extracted code**

  Copy verbatim: `DeviceIdentity` interface, `loadDeviceIdentity()`, `deriveDeviceId()`, `buildDeviceAuthPayload()`, `signData()`, `GatewayClient` class. Export them all. Keep `GATEWAY_URL`, `GATEWAY_TOKEN` as exported constants so callers can override.

  ```typescript
  // src/gateway-client.ts
  import { readFileSync } from 'fs';
  import WebSocket from 'ws';
  import { v4 as uuidv4 } from 'uuid';
  import crypto from 'crypto';

  export const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789';
  export const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '53f48388b0c74d7eb8aded3b643afd6b';

  export interface DeviceIdentity { ... }
  export function loadDeviceIdentity(): DeviceIdentity | null { ... }
  // ... all other functions and GatewayClient class
  export { GatewayClient };
  ```

- [ ] **Step 3: Verify it compiles**

  Run: `npx ts-node --transpile-only src/gateway-client.ts`
  Expected: no output, no errors.

- [ ] **Step 4: Commit**

  ```bash
  git add src/gateway-client.ts
  git commit -m "refactor: extract GatewayClient to src/gateway-client.ts"
  ```

---

## Task 2: `app-server.ts` — skeleton + static serving

**Files:**
- Create: `app-server.ts`
- Create: `src/app/index.html` (placeholder)

- [ ] **Step 1: Create placeholder `src/app/index.html`**

  ```html
  <!DOCTYPE html>
  <html lang="zh"><head><meta charset="UTF-8"><title>OpenClaw</title></head>
  <body><h1>Loading...</h1></body></html>
  ```

- [ ] **Step 2: Create `app-server.ts` with static serving + health endpoint**

  ```typescript
  import { createServer, IncomingMessage, ServerResponse } from 'http';
  import { readFileSync, existsSync } from 'fs';
  import { join, extname } from 'path';

  const PORT = 3100;
  const APP_DIR = join(__dirname, 'src/app');

  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.ico':  'image/x-icon',
  };

  function serveStatic(res: ServerResponse, filePath: string) {
    if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(readFileSync(filePath));
  }

  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = req.url || '/';

    if (url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Static files
    const filePath = url === '/' ? join(APP_DIR, 'index.html')
      : join(APP_DIR, url.replace(/^\//, ''));
    serveStatic(res, filePath);
  });

  server.listen(PORT, () => console.log(`App server running at http://localhost:${PORT}`));
  ```

- [ ] **Step 3: Smoke-test**

  Run: `npx ts-node app-server.ts` (in background or separate terminal)
  Run: `curl http://localhost:3100/api/health`
  Expected: `{"ok":true}`
  Run: `curl http://localhost:3100/` — returns the placeholder HTML.

- [ ] **Step 4: Commit**

  ```bash
  git add app-server.ts src/app/index.html
  git commit -m "feat: add app-server skeleton with static serving (port 3100)"
  ```

---

## Task 3: `app-server.ts` — gateway API endpoints

**Files:**
- Modify: `app-server.ts`

Adds `/api/agents`, `/api/sessions`, `/api/chat` (SSE), `/api/events` (permanent SSE).

- [ ] **Step 1: Import GatewayClient and wire up a persistent global connection**

  At the top of `app-server.ts`:
  ```typescript
  import { loadDeviceIdentity, GatewayClient } from './src/gateway-client';

  let gatewayClient: GatewayClient | null = null;
  let gatewayReady = false;

  async function ensureGateway(): Promise<GatewayClient> {
    if (gatewayClient && gatewayReady) return gatewayClient;
    const device = loadDeviceIdentity();
    if (!device) throw new Error('Device not paired');
    gatewayClient = new GatewayClient(device);
    await gatewayClient.connect();
    gatewayReady = true;
    return gatewayClient;
  }
  ```
  Call `ensureGateway().catch(console.error)` at startup (best-effort pre-connect).

- [ ] **Step 2: Add `/api/agents`**

  ```typescript
  if (url === '/api/agents') {
    try {
      const client = await ensureGateway();
      const result = await client.call('agents.list', {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  ```

  Note: `GatewayClient` needs a generic `call(method, params)` method that sends a req frame and returns the response payload. Add this to `src/gateway-client.ts`:
  ```typescript
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = `req-${++this.reqId}`;
    const frame = { type: 'req', id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 8000);
      this.pendingResolves.set(id, (res: any) => {
        clearTimeout(timeout);
        if (res.ok === false) reject(new Error(res.error?.message || method + ' failed'));
        else resolve(res.payload);
      });
      this.ws!.send(JSON.stringify(frame));
    });
  }
  ```

- [ ] **Step 3: Add `/api/sessions`**

  ```typescript
  if (url.startsWith('/api/sessions') && req.method === 'GET') {
    const agentId = new URL(url, 'http://x').searchParams.get('agentId') || undefined;
    try {
      const client = await ensureGateway();
      const result = await client.call('sessions.list', agentId ? { agentId } : {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  ```

- [ ] **Step 4: Add `/api/events` permanent SSE**

  ```typescript
  const eventSubscribers = new Set<ServerResponse>();

  // In route handler:
  if (url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');
    eventSubscribers.add(res);
    req.on('close', () => eventSubscribers.delete(res));
    return; // keep open
  }

  // After ensureGateway() at startup, subscribe to all events:
  gatewayClient.onEvent((event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const sub of eventSubscribers) {
      try { sub.write(data); } catch { eventSubscribers.delete(sub); }
    }
  });
  ```

- [ ] **Step 5: Add `/api/chat` SSE (port from test-server.ts)**

  Copy the `/api/chat` handler logic from `test-server.ts` verbatim (lines 324–458), adapting to use the shared `ensureGateway()` instead of `globalGatewayClient`. Keep the same request body shape: `{ message, agentId, reuseSession, sessionKey, queueMode }`.

- [ ] **Step 6: Verify endpoints**

  Run: `curl http://localhost:3100/api/agents`
  Expected: JSON with agents array (requires gateway running).

  Run: `curl -N http://localhost:3100/api/events`
  Expected: `data: {"type":"connected"}` then stream stays open.

- [ ] **Step 7: Commit**

  ```bash
  git add app-server.ts src/gateway-client.ts
  git commit -m "feat: add gateway API endpoints to app-server (/api/agents, /api/sessions, /api/chat, /api/events)"
  ```

---

## Task 4: `app-server.ts` — ASR WebSocket proxy + TTS HTTP endpoint

**Files:**
- Modify: `app-server.ts`

ASR/TTS logic stays server-side (same as test-page.ts). New endpoints:
- `WS /ws/asr` — browser sends PCM audio, server relays to ByteDance ASR, sends back `{type:'partial',text}` / `{type:'final',text}` / `{type:'barge_in'}` JSON frames
- `POST /api/tts` — body `{text}`, streams MP3 audio chunks back

- [ ] **Step 1: Extract ASR binary protocol helpers from test-page.ts**

  Copy `asrHeader()`, `asrFullClientRequest()`, `asrAudioOnly()`, `asrAudioOnlyLast()` from `src/test-page.ts` (lines 75–107) into `app-server.ts`.

- [ ] **Step 2: Extract `StreamingAsrSession` class from test-page.ts**

  Copy `StreamingAsrSession` class (lines 617–840 approx) from `src/test-page.ts` into `app-server.ts`. Adapt constructor signature:
  ```typescript
  constructor(
    private sendEvent: (data: unknown) => void,
    private onFinal: (text: string) => Promise<void>,
    private onBargeIn?: () => void,
  )
  ```
  The `onFinal` callback will be provided by the WebSocket handler — in dictation mode it just echoes the text back to the browser; in call mode it also calls `/api/chat`.

- [ ] **Step 3: Add WebSocket server for `/ws/asr`**

  ```typescript
  import { WebSocketServer } from 'ws';
  import { config } from './src/config';

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    if (req.url !== '/ws/asr') { ws.close(); return; }

    const send = (data: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
    };

    const session = new StreamingAsrSession(
      send,
      async (text) => { send({ type: 'final_ack', text }); }, // call mode wires this differently via main.js
      () => { send({ type: 'barge_in' }); }
    );

    session.start();

    ws.on('message', (data) => {
      if (Buffer.isBuffer(data)) session.sendAudio(data);
    });

    ws.on('close', () => session.stop());
  });
  ```

  Add `sendAudio(chunk: Buffer)` and `stop()` methods to `StreamingAsrSession`.

- [ ] **Step 4: Extract `TtsConnection` class from test-page.ts**

  Copy `TtsConnection` class (lines 417–600 approx) from `src/test-page.ts` into `app-server.ts`. Keep the same interface: `synthesize(text, onAudioChunk): Promise<void>`.

- [ ] **Step 5: Add `/api/tts` endpoint**

  ```typescript
  if (url === '/api/tts' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const { text } = JSON.parse(body);
      if (!text) { res.writeHead(400); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Transfer-Encoding': 'chunked' });
      try {
        if (!globalTtsConn) globalTtsConn = new TtsConnection();
        await globalTtsConn.synthesize(text, (chunk) => res.write(chunk));
      } catch (e) {
        console.error('[TTS]', e);
      }
      res.end();
    });
    return;
  }
  ```

- [ ] **Step 6: Smoke-test TTS**

  Run: `curl -X POST http://localhost:3100/api/tts -H 'Content-Type: application/json' -d '{"text":"你好"}' --output /tmp/test.mp3`
  Expected: `/tmp/test.mp3` is a valid MP3 file (`file /tmp/test.mp3` shows MPEG audio).

- [ ] **Step 7: Commit**

  ```bash
  git add app-server.ts
  git commit -m "feat: add ASR WebSocket proxy (/ws/asr) and TTS streaming (/api/tts) to app-server"
  ```

---

## Task 5: Frontend HTML + CSS skeleton

**Files:**
- Modify: `src/app/index.html`
- Create: `src/app/style.css`

- [ ] **Step 1: Write `src/app/index.html`**

  ```html
  <!DOCTYPE html>
  <html lang="zh">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>OpenClaw</title>
    <link rel="stylesheet" href="style.css">
  </head>
  <body>
    <!-- Header -->
    <header id="header">
      <span id="status-dot" class="dot dot--off"></span>
      <span class="brand">OpenClaw</span>
      <div id="agent-selector"></div>
      <button id="tasks-toggle" class="btn-icon">任务 ▶</button>
    </header>

    <!-- Main area -->
    <div id="main">
      <div id="chat-area">
        <div id="messages"></div>
      </div>
      <aside id="tasks-sidebar" class="sidebar--hidden">
        <div id="tasks-panel"></div>
      </aside>
    </div>

    <!-- Input bar -->
    <footer id="input-bar">
      <!-- Normal mode -->
      <div id="input-normal">
        <button id="btn-dictate" class="btn-icon" title="听写">🎤</button>
        <textarea id="text-input" rows="1" placeholder="输入消息，或点击🎤听写…"></textarea>
        <button id="btn-send" class="btn-primary">↑</button>
        <button id="btn-call" class="btn-icon btn-call" title="开始通话">📞</button>
      </div>
      <!-- Call mode (hidden by default) -->
      <div id="input-call" class="hidden">
        <div class="wave-container">
          <canvas id="wave-user" width="200" height="60"></canvas>
          <span class="wave-label">你</span>
          <span class="wave-label">Agent</span>
          <canvas id="wave-agent" width="200" height="60"></canvas>
        </div>
        <button id="btn-hangup" class="btn-danger">🔴 挂断</button>
      </div>
    </footer>

    <script type="module" src="main.js"></script>
  </body>
  </html>
  ```

- [ ] **Step 2: Write `src/app/style.css`**

  Dark theme, clean sans-serif. Key rules:
  ```css
  :root {
    --bg: #1a1a1a; --bg2: #242424; --bg3: #2e2e2e;
    --text: #e8e8e8; --text2: #999;
    --accent: #4f9cf9; --danger: #e05555; --success: #52c878;
    --border: #333;
    --sidebar-w: 300px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: var(--bg); color: var(--text); height: 100vh;
         display: flex; flex-direction: column; overflow: hidden; }

  /* Header */
  #header { display: flex; align-items: center; gap: 12px; padding: 10px 16px;
             background: var(--bg2); border-bottom: 1px solid var(--border);
             height: 48px; flex-shrink: 0; }
  .brand { font-weight: 600; flex: 1; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text2); }
  .dot--on { background: var(--success); }
  .dot--off { background: var(--text2); }

  /* Main layout */
  #main { display: flex; flex: 1; overflow: hidden; }
  #chat-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex;
               flex-direction: column; gap: 12px; }

  /* Messages */
  .msg { max-width: 75%; padding: 10px 14px; border-radius: 12px; line-height: 1.5; }
  .msg--user { align-self: flex-end; background: var(--accent); color: #fff; }
  .msg--assistant { align-self: flex-start; background: var(--bg3); }
  .msg--thinking { color: var(--text2); font-style: italic; font-size: 0.9em; }

  /* Sidebar */
  #tasks-sidebar { width: var(--sidebar-w); background: var(--bg2);
                   border-left: 1px solid var(--border); overflow-y: auto;
                   transition: width 0.2s; }
  .sidebar--hidden { width: 0 !important; overflow: hidden; }
  #tasks-panel { padding: 12px; }
  .task-node { padding: 6px 8px; border-radius: 6px; font-size: 0.85em;
               margin-bottom: 4px; background: var(--bg3); cursor: default; }
  .task-node--running { border-left: 3px solid var(--accent); }
  .task-node--done    { border-left: 3px solid var(--success); opacity: 0.7; }
  .task-node--error   { border-left: 3px solid var(--danger); }
  .task-children { margin-left: 16px; }

  /* Input bar */
  #input-bar { padding: 10px 16px; background: var(--bg2);
               border-top: 1px solid var(--border); flex-shrink: 0; }
  #input-normal { display: flex; align-items: flex-end; gap: 8px; }
  #text-input { flex: 1; background: var(--bg3); border: 1px solid var(--border);
                color: var(--text); border-radius: 8px; padding: 8px 12px;
                resize: none; font-size: 0.95em; max-height: 120px; }
  #text-input:focus { outline: none; border-color: var(--accent); }
  .btn-icon { background: none; border: none; color: var(--text2); font-size: 1.2em;
               cursor: pointer; padding: 6px; border-radius: 6px; }
  .btn-icon:hover { background: var(--bg3); color: var(--text); }
  .btn-primary { background: var(--accent); border: none; color: #fff;
                  border-radius: 8px; padding: 8px 14px; cursor: pointer; font-size: 1em; }
  .btn-danger { background: var(--danger); border: none; color: #fff;
                 border-radius: 8px; padding: 8px 20px; cursor: pointer; font-size: 0.95em; }
  .btn-call.active { color: var(--success); }

  /* Call mode */
  #input-call { display: flex; align-items: center; justify-content: center; gap: 24px; padding: 8px 0; }
  .wave-container { display: flex; align-items: center; gap: 8px; }
  .wave-label { font-size: 0.8em; color: var(--text2); }
  .hidden { display: none !important; }
  ```

- [ ] **Step 3: Verify page loads**

  Open `http://localhost:3100/` in browser.
  Expected: dark background, header with "OpenClaw" text, empty chat area, input bar at bottom.

- [ ] **Step 4: Commit**

  ```bash
  git add src/app/index.html src/app/style.css
  git commit -m "feat: add frontend HTML structure and dark theme CSS"
  ```

---

## Task 6: `src/app/api.js` — data layer

**Files:**
- Create: `src/app/api.js`

Single module that owns all server communication. Exposes an event bus.

- [ ] **Step 1: Write `src/app/api.js`**

  ```javascript
  // src/app/api.js
  const listeners = {};

  export function on(event, fn) {
    (listeners[event] ||= []).push(fn);
  }

  export function off(event, fn) {
    listeners[event] = (listeners[event] || []).filter(f => f !== fn);
  }

  function emit(event, data) {
    (listeners[event] || []).forEach(fn => fn(data));
  }

  // ── REST helpers ──────────────────────────────────────────
  export async function fetchAgents() {
    const r = await fetch('/api/agents');
    return r.json();
  }

  export async function fetchSessions(agentId) {
    const url = agentId ? `/api/sessions?agentId=${encodeURIComponent(agentId)}` : '/api/sessions';
    const r = await fetch(url);
    return r.json();
  }

  export async function* streamChat({ message, agentId, sessionKey, reuseSession, queueMode }) {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, agentId, sessionKey, reuseSession, queueMode }),
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        if (!part.startsWith('data: ')) continue;
        const raw = part.slice(6).trim();
        if (raw === '[DONE]' || raw === '[TIMEOUT]') { yield { done: true }; return; }
        try { yield JSON.parse(raw); } catch {}
      }
    }
  }

  // ── Persistent event stream ───────────────────────────────
  let evtSource = null;

  export function connectEvents() {
    if (evtSource) return;
    evtSource = new EventSource('/api/events');
    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        emit('gateway-event', data);
        if (data.event === 'agent')  emit('agent-event', data);
        if (data.event === 'chat')   emit('chat-event', data);
      } catch {}
    };
    evtSource.onerror = () => {
      evtSource.close(); evtSource = null;
      setTimeout(connectEvents, 3000); // reconnect
    };
  }
  ```

- [ ] **Step 2: Create `src/app/main.js` stub to test api.js loads**

  ```javascript
  // src/app/main.js
  import { connectEvents, on } from './api.js';

  connectEvents();
  on('gateway-event', (e) => console.log('[event]', e));
  console.log('main.js loaded');
  ```

- [ ] **Step 3: Open browser console on `http://localhost:3100/`**

  Expected: `main.js loaded`, `[event] {type:"connected"}` in console.

- [ ] **Step 4: Commit**

  ```bash
  git add src/app/api.js src/app/main.js
  git commit -m "feat: add api.js data layer with event bus and REST helpers"
  ```

---

## Task 7: `src/app/ui-agents.js` — agent selector

**Files:**
- Create: `src/app/ui-agents.js`

- [ ] **Step 1: Write `src/app/ui-agents.js`**

  ```javascript
  // src/app/ui-agents.js
  import { fetchAgents } from './api.js';

  let onChangeCallback = null;
  let currentAgentId = null;

  export function initAgentSelector(containerId, onChange) {
    onChangeCallback = onChange;
    const el = document.getElementById(containerId);
    el.innerHTML = '<select id="agent-select" style="background:#333;color:#e8e8e8;border:1px solid #444;border-radius:6px;padding:4px 8px;"></select>';
    const sel = el.querySelector('select');
    sel.addEventListener('change', () => {
      currentAgentId = sel.value;
      onChangeCallback?.(currentAgentId);
    });
    loadAgents(sel);
  }

  async function loadAgents(sel) {
    try {
      const data = await fetchAgents();
      const agents = data?.agents || [];
      sel.innerHTML = agents.map(a =>
        `<option value="${a.id}">${a.id}</option>`
      ).join('');
      if (agents.length > 0) {
        currentAgentId = agents[0].id;
        onChangeCallback?.(currentAgentId);
      }
    } catch (e) {
      sel.innerHTML = '<option value="voice">voice</option>';
      currentAgentId = 'voice';
      onChangeCallback?.('voice');
    }
  }

  export function getAgentId() { return currentAgentId; }
  ```

- [ ] **Step 2: Wire in `main.js`**

  ```javascript
  import { initAgentSelector } from './ui-agents.js';
  initAgentSelector('agent-selector', (id) => console.log('agent:', id));
  ```

- [ ] **Step 3: Verify dropdown appears with agent names in header**

- [ ] **Step 4: Commit**

  ```bash
  git add src/app/ui-agents.js src/app/main.js
  git commit -m "feat: add agent selector dropdown"
  ```

---

## Task 8: `src/app/ui-chat.js` — conversation messages

**Files:**
- Create: `src/app/ui-chat.js`

- [ ] **Step 1: Write `src/app/ui-chat.js`**

  ```javascript
  // src/app/ui-chat.js
  import { streamChat } from './api.js';

  const messagesEl = document.getElementById('messages');
  let currentSessionKey = null;
  let onSessionKey = null;

  export function initChat(onSessionKeyCallback) {
    onSessionKey = onSessionKeyCallback;
  }

  export function getCurrentSessionKey() { return currentSessionKey; }

  export function appendMessage(role, text) {
    const div = document.createElement('div');
    div.className = `msg msg--${role}`;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  export async function sendMessage({ text, agentId, reuseSession, sessionKey, queueMode = 'interrupt' }) {
    if (!text?.trim()) return;
    appendMessage('user', text);

    const thinking = appendMessage('assistant', '...');
    thinking.classList.add('msg--thinking');
    let fullText = '';

    try {
      for await (const event of streamChat({ message: text, agentId, sessionKey, reuseSession, queueMode })) {
        if (event.done) break;

        // Track sessionKey from first metric event
        if (event.type === 'metric' && event.metric === 'session_start' && !currentSessionKey) {
          currentSessionKey = event.sessionKey;
          onSessionKey?.(currentSessionKey);
        }

        // Stream assistant text
        if (event.event === 'agent' && event.payload?.stream === 'assistant') {
          const delta = event.payload?.data?.delta;
          if (typeof delta === 'string') {
            if (thinking.classList.contains('msg--thinking')) {
              thinking.classList.remove('msg--thinking');
              thinking.textContent = '';
            }
            fullText += delta;
            thinking.textContent = fullText;
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        }
      }
    } catch (e) {
      thinking.textContent = `错误: ${e.message}`;
      thinking.style.color = 'var(--danger)';
    }

    if (!fullText && thinking.classList.contains('msg--thinking')) {
      thinking.remove();
    }
  }
  ```

- [ ] **Step 2: Wire input bar in `main.js`**

  ```javascript
  import { initChat, sendMessage, getCurrentSessionKey } from './ui-chat.js';
  import { getAgentId } from './ui-agents.js';

  initChat((key) => console.log('sessionKey:', key));

  const textInput = document.getElementById('text-input');
  const btnSend = document.getElementById('btn-send');

  async function handleSend() {
    const text = textInput.value.trim();
    if (!text) return;
    textInput.value = '';
    textInput.style.height = '';
    await sendMessage({
      text,
      agentId: getAgentId(),
      reuseSession: true,
      sessionKey: getCurrentSessionKey(),
    });
  }

  btnSend.addEventListener('click', handleSend);
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });

  // Auto-resize textarea
  textInput.addEventListener('input', () => {
    textInput.style.height = '';
    textInput.style.height = Math.min(textInput.scrollHeight, 120) + 'px';
  });
  ```

- [ ] **Step 3: End-to-end test**

  Open browser, type a message, press Enter. Expected: message appears, assistant streams reply with live text update.

- [ ] **Step 4: Commit**

  ```bash
  git add src/app/ui-chat.js src/app/main.js
  git commit -m "feat: add conversation UI with streaming assistant replies"
  ```

---

## Task 9: `src/app/ui-tasks.js` — task board

**Files:**
- Create: `src/app/ui-tasks.js`

- [ ] **Step 1: Write `src/app/ui-tasks.js`**

  ```javascript
  // src/app/ui-tasks.js
  import { fetchSessions, on } from './api.js';

  const panel = document.getElementById('tasks-panel');
  const toggleBtn = document.getElementById('tasks-toggle');
  const sidebar = document.getElementById('tasks-sidebar');

  // sessionKey → { key, spawnedBy, status, preview, children[] }
  const nodes = new Map();
  let currentAgentId = null;
  let sidebarOpen = false;

  toggleBtn.addEventListener('click', () => {
    sidebarOpen = !sidebarOpen;
    sidebar.classList.toggle('sidebar--hidden', !sidebarOpen);
    toggleBtn.textContent = sidebarOpen ? '任务 ◀' : '任务 ▶';
  });

  export async function initTasks(agentId) {
    currentAgentId = agentId;
    nodes.clear();
    await refresh();
  }

  async function refresh() {
    try {
      const data = await fetchSessions(currentAgentId);
      const sessions = data?.sessions || [];
      for (const s of sessions) {
        upsertNode(s.key, {
          key: s.key,
          spawnedBy: s.spawnedBy,
          preview: s.lastMessagePreview || s.derivedTitle || s.key,
          status: s.abortedLastRun ? 'aborted' : 'idle',
        });
      }
      render();
    } catch (e) {
      console.error('[tasks] refresh failed:', e);
    }
  }

  function upsertNode(key, data) {
    const existing = nodes.get(key) || {};
    nodes.set(key, { ...existing, ...data, children: existing.children || [] });
  }

  // Listen to gateway agent events for real-time status
  on('agent-event', (event) => {
    const payload = event.payload || {};
    const key = payload.sessionKey;
    if (!key) return;

    if (payload.stream === 'lifecycle') {
      const phase = payload.data?.phase;
      if (phase === 'start') {
        upsertNode(key, { key, status: 'running' });
        render();
      } else if (phase === 'end') {
        upsertNode(key, { key, status: 'done' });
        render();
        // New session appeared — refresh list
        if (!nodes.has(key)) refresh();
      } else if (phase === 'error') {
        upsertNode(key, { key, status: 'error' });
        render();
      }
    }
  });

  const STATUS_ICON = { running: '⚡', done: '✓', error: '✗', aborted: '↩', idle: '—' };

  function renderNode(node, depth = 0) {
    const div = document.createElement('div');
    div.className = `task-node task-node--${node.status}`;
    div.style.marginLeft = depth * 12 + 'px';
    const icon = STATUS_ICON[node.status] || '—';
    const label = (node.preview || node.key).slice(0, 60);
    div.textContent = `${icon} ${label}`;
    div.title = node.key;
    return div;
  }

  function render() {
    panel.innerHTML = '';
    // Build tree
    const roots = [];
    for (const node of nodes.values()) {
      if (!node.spawnedBy || !nodes.has(node.spawnedBy)) roots.push(node);
      else {
        const parent = nodes.get(node.spawnedBy);
        if (!parent.children.includes(node.key)) parent.children.push(node.key);
      }
    }
    // Sort roots: running first, then by key (newest last)
    roots.sort((a, b) => (a.status === 'running' ? -1 : b.status === 'running' ? 1 : 0));

    function renderTree(key, depth) {
      const node = nodes.get(key);
      if (!node) return;
      panel.appendChild(renderNode(node, depth));
      (node.children || []).forEach(c => renderTree(c, depth + 1));
    }
    roots.forEach(r => renderTree(r.key, 0));
  }
  ```

- [ ] **Step 2: Wire in `main.js`**

  ```javascript
  import { initTasks } from './ui-tasks.js';
  // Inside agent change callback:
  initAgentSelector('agent-selector', (id) => {
    initTasks(id);
  });
  ```

- [ ] **Step 3: Verify sidebar shows sessions**

  Click "任务 ▶" — sidebar opens, sessions list appears. Send a message — relevant node flashes ⚡ running, then ✓ done.

- [ ] **Step 4: Commit**

  ```bash
  git add src/app/ui-tasks.js src/app/main.js
  git commit -m "feat: add task board sidebar with real-time session tree"
  ```

---

## Task 10: `src/app/voice.js` — dictation mode + call mode

**Files:**
- Create: `src/app/voice.js`

Handles: (a) dictation — click mic, speak, text fills textarea; (b) call mode — full-duplex waveforms + barge-in.

- [ ] **Step 1: Write `src/app/voice.js` — microphone + ASR WebSocket**

  ```javascript
  // src/app/voice.js
  let asrWs = null;
  let audioCtx = null;
  let processor = null;
  let micStream = null;
  let vadThreshold = 0.01; // raised during TTS to avoid echo

  export function setVadThreshold(v) { vadThreshold = v; }

  async function openMic() {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
    audioCtx = new AudioContext({ sampleRate: 16000 });
    const src = audioCtx.createMediaStreamSource(micStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    src.connect(processor);
    processor.connect(audioCtx.destination);
    return processor;
  }

  function closeMic() {
    processor?.disconnect();
    micStream?.getTracks().forEach(t => t.stop());
    audioCtx?.close();
    processor = null; micStream = null; audioCtx = null;
  }

  function connectAsrWs(onMessage) {
    const ws = new WebSocket(`ws://${location.host}/ws/asr`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
    ws.onerror = () => ws.close();
    return ws;
  }

  // ── Dictation mode ────────────────────────────────────────
  let dictating = false;

  export async function startDictation(onPartial, onFinal) {
    if (dictating) return;
    dictating = true;
    asrWs = connectAsrWs((msg) => {
      if (msg.type === 'partial') onPartial(msg.text);
      if (msg.type === 'final')   { onFinal(msg.text); stopDictation(); }
    });
    const proc = await openMic();
    proc.onaudioprocess = (e) => {
      if (!dictating || asrWs?.readyState !== 1) return;
      const f32 = e.inputBuffer.getChannelData(0);
      // Simple VAD: skip silent frames
      const rms = Math.sqrt(f32.reduce((s, v) => s + v*v, 0) / f32.length);
      if (rms < vadThreshold) return;
      // Convert f32 → PCM16
      const pcm = new Int16Array(f32.length);
      f32.forEach((v, i) => pcm[i] = Math.max(-32768, Math.min(32767, v * 32768)));
      asrWs.send(pcm.buffer);
    };
  }

  export function stopDictation() {
    dictating = false;
    asrWs?.close(); asrWs = null;
    closeMic();
  }

  // ── TTS playback ──────────────────────────────────────────
  let ttsAudio = null;

  export async function speak(text) {
    stopSpeaking();
    setVadThreshold(0.03); // raise threshold to reduce echo
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    ttsAudio = new Audio(url);
    ttsAudio.onended = () => { setVadThreshold(0.01); URL.revokeObjectURL(url); };
    ttsAudio.play();
    return ttsAudio;
  }

  export function stopSpeaking() {
    ttsAudio?.pause();
    ttsAudio = null;
    setVadThreshold(0.01);
  }

  export function isSpeaking() { return ttsAudio && !ttsAudio.paused; }

  // ── Call mode ─────────────────────────────────────────────
  let calling = false;
  let callOnFinal = null;

  const canvasUser  = document.getElementById('wave-user');
  const canvasAgent = document.getElementById('wave-agent');
  const ctxUser  = canvasUser?.getContext('2d');
  const ctxAgent = canvasAgent?.getContext('2d');

  export async function startCall(onFinal, onBargeIn) {
    if (calling) return;
    calling = true;
    callOnFinal = onFinal;

    asrWs = connectAsrWs(async (msg) => {
      if (msg.type === 'barge_in') {
        stopSpeaking();
        onBargeIn?.();
      }
      if (msg.type === 'final') {
        onFinal(msg.text);
      }
    });

    const proc = await openMic();
    const userLevels = new Float32Array(30);
    let idx = 0;

    proc.onaudioprocess = (e) => {
      if (!calling || asrWs?.readyState !== 1) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const rms = Math.sqrt(f32.reduce((s, v) => s + v*v, 0) / f32.length);
      userLevels[idx++ % 30] = rms;
      drawWave(ctxUser, canvasUser, userLevels, '#4f9cf9');

      if (rms < vadThreshold) return;
      const pcm = new Int16Array(f32.length);
      f32.forEach((v, i) => pcm[i] = Math.max(-32768, Math.min(32767, v * 32768)));
      asrWs.send(pcm.buffer);
    };

    animateAgentWave(); // idle animation until agent speaks
  }

  export function stopCall() {
    calling = false;
    asrWs?.close(); asrWs = null;
    closeMic();
    stopSpeaking();
    clearWave(ctxUser, canvasUser);
    clearWave(ctxAgent, canvasAgent);
  }

  function drawWave(ctx, canvas, levels, color) {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    const w = canvas.width / levels.length;
    levels.forEach((v, i) => {
      const h = Math.min(canvas.height, v * canvas.height * 8);
      ctx.fillRect(i * w, (canvas.height - h) / 2, w - 1, h);
    });
  }

  function clearWave(ctx, canvas) {
    if (ctx) ctx.clearRect(0, 0, canvas?.width || 0, canvas?.height || 0);
  }

  let agentWaveTimer = null;
  const agentLevels = new Float32Array(30);
  let agentIdx = 0;

  function animateAgentWave() {
    if (agentWaveTimer) return;
    agentWaveTimer = setInterval(() => {
      if (!calling) { clearInterval(agentWaveTimer); agentWaveTimer = null; return; }
      agentLevels[agentIdx++ % 30] = isSpeaking() ? (Math.random() * 0.3 + 0.05) : 0.01;
      drawWave(ctxAgent, canvasAgent, agentLevels, '#52c878');
    }, 50);
  }
  ```

- [ ] **Step 2: Wire dictation button in `main.js`**

  ```javascript
  import { startDictation, stopDictation, speak, startCall, stopCall } from './voice.js';

  const btnDictate = document.getElementById('btn-dictate');
  let dictating = false;

  btnDictate.addEventListener('click', async () => {
    if (dictating) { stopDictation(); btnDictate.textContent = '🎤'; dictating = false; return; }
    dictating = true;
    btnDictate.textContent = '⏹';
    await startDictation(
      (partial) => { textInput.value = partial; },
      (final) => { textInput.value = final; btnDictate.textContent = '🎤'; dictating = false; }
    );
  });
  ```

- [ ] **Step 3: Wire call button and hangup in `main.js`**

  ```javascript
  const btnCall = document.getElementById('btn-call');
  const btnHangup = document.getElementById('btn-hangup');
  const inputNormal = document.getElementById('input-normal');
  const inputCall = document.getElementById('input-call');
  let inCall = false;

  btnCall.addEventListener('click', async () => {
    inCall = true;
    inputNormal.classList.add('hidden');
    inputCall.classList.remove('hidden');
    await startCall(
      async (text) => {
        // Final ASR text → send to agent + speak reply
        const { sendMessage } = await import('./ui-chat.js');
        appendMessage('user', text);
        // stream chat, collect full reply, speak it
        let reply = '';
        for await (const ev of streamChat({ message: text, agentId: getAgentId(),
                                            sessionKey: getCurrentSessionKey(),
                                            reuseSession: true, queueMode: 'interrupt' })) {
          if (ev.done) break;
          if (ev.event === 'agent' && ev.payload?.stream === 'assistant') {
            const d = ev.payload?.data?.delta;
            if (d) reply += d;
          }
        }
        if (reply) {
          appendMessage('assistant', reply);
          await speak(reply);
        }
      },
      () => { /* barge-in: already handled inside voice.js (stopSpeaking) */ }
    );
  });

  btnHangup.addEventListener('click', () => {
    inCall = false;
    stopCall();
    inputCall.classList.add('hidden');
    inputNormal.classList.remove('hidden');
  });
  ```

- [ ] **Step 4: Verify dictation mode**

  Click 🎤, speak into mic. Expected: text fills textarea in real-time, final text appears, button resets.

- [ ] **Step 5: Verify call mode**

  Click 📞. Expected: input bar switches to wave display. Speak → agent replies as audio. Click 🔴 挂断 → returns to text mode.

- [ ] **Step 6: Commit**

  ```bash
  git add src/app/voice.js src/app/main.js
  git commit -m "feat: add voice dictation, TTS playback, and full-duplex call mode"
  ```

---

## Task 11: `main.js` — final wiring + status dot

**Files:**
- Modify: `src/app/main.js`

- [ ] **Step 1: Add gateway connection status to the dot in the header**

  ```javascript
  import { connectEvents, on } from './api.js';
  const dot = document.getElementById('status-dot');

  connectEvents();
  on('gateway-event', (e) => {
    if (e.type === 'connected') dot.className = 'dot dot--on';
  });
  // Dim dot if events stop (handled by reconnect in api.js)
  ```

- [ ] **Step 2: Wire task board refresh when session key changes**

  ```javascript
  import { initTasks } from './ui-tasks.js';
  // In initChat callback:
  initChat((key) => {
    // Refresh tasks when a new session appears
    initTasks(getAgentId());
  });
  ```

- [ ] **Step 3: Full end-to-end smoke test**

  1. Start gateway: `openclaw gateway`
  2. Start app: `npx ts-node app-server.ts`
  3. Open `http://localhost:3100`
  4. ✅ Agent dropdown populates
  5. ✅ Status dot turns green
  6. ✅ Type + send message → streaming reply appears
  7. ✅ Click 任务 ▶ → task board opens, shows sessions
  8. ✅ Send message → task node shows ⚡ running then ✓ done
  9. ✅ Click 🎤 → dictation → text fills input
  10. ✅ Click 📞 → call mode → speak → agent replies as audio → 🔴 挂断 returns to text

- [ ] **Step 4: Add startup script to package.json**

  ```json
  "app": "ts-node app-server.ts"
  ```

  Run: `npm run app`

- [ ] **Step 5: Final commit**

  ```bash
  git add src/app/main.js package.json
  git commit -m "feat: complete production chat UI wiring and smoke test"
  ```

---

## Done

Access at `http://localhost:3100`. Debug tools remain at `http://localhost:3017/lobster` and `http://localhost:3017/para`.
