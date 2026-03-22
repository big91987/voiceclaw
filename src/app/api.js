// src/app/api.js — data layer: REST helpers + SSE event bus

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

// ── REST helpers ───────────────────────────────────────────
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

// ── Persistent event stream ────────────────────────────────
let evtSource = null;

export function connectEvents() {
  if (evtSource) return;
  evtSource = new EventSource('/api/events');
  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      emit('gateway-event', data);
      if (data.event === 'agent') emit('agent-event', data);
      if (data.event === 'chat')  emit('chat-event', data);
    } catch {}
  };
  evtSource.onerror = () => {
    evtSource.close(); evtSource = null;
    setTimeout(connectEvents, 3000);
  };
}

// ── Session events ────────────────────────────────────────
export function emitSessionChange(sessionKey) {
  emit('session-change', sessionKey);
}

// ── OpenClaw path config ──────────────────────────────────
export const DEFAULT_OPENCLAW_PATH = '~/.openclaw';

export function getOpenClawPath() {
  return localStorage.getItem('openclawPath') || DEFAULT_OPENCLAW_PATH;
}

export function setOpenClawPath(path) {
  localStorage.setItem('openclawPath', path);
}

// ── OpenClaw session file APIs ─────────────────────────────
export async function fetchSessionsFromOpenClaw(agentId, openclawPath) {
  const url = `/api/openclaw/sessions?agentId=${encodeURIComponent(agentId)}&openclawPath=${encodeURIComponent(openclawPath)}`;
  const r = await fetch(url);
  return r.json();
}

export async function fetchChatHistory(agentId, sessionId, openclawPath) {
  const url = `/api/openclaw/history?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}&openclawPath=${encodeURIComponent(openclawPath)}`;
  const r = await fetch(url);
  return r.json();
}
