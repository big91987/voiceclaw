// src/app/ui-sessions.js — session selector dropdown (reads from openclaw .jsonl files)
import { fetchSessionsFromOpenClaw, fetchSessions, getOpenClawPath, emitSessionChange } from './api.js';

let onChangeCallback = null;
let currentSessionId = null;
let currentAgentId = null;
let sessionContainerId = null;
let selElement = null;
// Maps sessionId (UUID) → sessionKey (full gateway key like agent:voice:web-sticky-xxx)
let sessionKeyMap = new Map();

export function initSessionSelector(containerId, agentId, onChange) {
  currentAgentId = agentId;
  sessionContainerId = containerId;
  onChangeCallback = onChange;
  const container = document.getElementById(containerId);
  container.innerHTML = `
    <select id="session-select"></select>
    <button id="btn-new-session" class="btn-icon" title="新建 session">+</button>
  `;
  selElement = container.querySelector('#session-select');
  selElement.addEventListener('change', async () => {
    const value = selElement.value;
    currentSessionId = value || null;
    if (currentSessionId) {
      // Resolve sessionKey from gateway for the selected session
      await resolveSessionKey(currentSessionId);
    }
    onChangeCallback?.(currentSessionId);
    emitSessionChange(currentSessionId);
  });
  document.getElementById('btn-new-session').addEventListener('click', () => {
    selElement.value = '';
    currentSessionId = null;
    onChangeCallback?.(null);
    emitSessionChange(null);
  });
  loadSessions(agentId);
}

export async function refreshSessions(agentId) {
  currentAgentId = agentId;
  if (!sessionContainerId) return;
  await loadSessions(agentId);
}

// Query gateway for sessionKey of a specific session
async function resolveSessionKey(sessionId) {
  try {
    const data = await fetchSessions(currentAgentId);
    const sessions = data?.sessions || [];
    // Match by sessionId (UUID), not by key.includes(sessionId) which fails
    // because gateway session keys like "agent:voice:web-sticky-xxx" use a different UUID
    const found = sessions.find(s => s.sessionId === sessionId);
    if (found && found.key) {
      sessionKeyMap.set(sessionId, found.key);
    }
  } catch {}
}

export function getSessionKeyForId(sessionId) {
  return sessionKeyMap.get(sessionId) || null;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function truncate(text, maxLen) {
  if (!text) return '';
  // Remove leading timestamp prefix like "[Sat 2026-03-21 17:21 GMT+8] "
  const cleaned = text.replace(/^\[[^\]]+\]\s*/, '').replace(/\n/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}

async function loadSessions(agentId) {
  if (!selElement) return;
  const newOpt = '<option value="">— 选择 session —</option>';
  try {
    const openclawPath = getOpenClawPath();
    const data = await fetchSessionsFromOpenClaw(agentId, openclawPath);
    const sessions = data?.sessions || [];
    if (sessions.length === 0) {
      selElement.innerHTML = newOpt;
      return;
    }
    selElement.innerHTML = newOpt + sessions.map(s => {
      const updated = formatTime(s.updatedAt);
      const preview = truncate(s.lastMessagePreview, 32);
      const label = preview ? `${updated} · ${preview}` : s.sessionId.slice(0, 8);
      return `<option value="${s.sessionId}">${label}</option>`;
    }).join('');
  } catch (err) {
    console.warn('[sessions] load failed:', err);
    selElement.innerHTML = newOpt;
  }
}

export function getSessionId() { return currentSessionId; }

// Returns the selected session ID (UUID), NOT the gateway session key
export function getSessionKey() { return currentSessionId; }

// Returns the resolved gateway session key for the selected historical session
// (e.g., "agent:voice:web-sticky-xxx"), or null if no historical session is selected
export function getResolvedSessionKey() {
  if (!currentSessionId) return null;
  return sessionKeyMap.get(currentSessionId) || null;
}

export function clearSessionKey() { currentSessionId = null; }
