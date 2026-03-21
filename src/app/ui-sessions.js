// src/app/ui-sessions.js — session selector dropdown
import { fetchSessions } from './api.js';

const NEW_SESSION_VALUE = '__new__';

let onChangeCallback = null;
let currentSessionKey = null;
let currentAgentId = null;
let sessionContainerId = null;

export function initSessionSelector(containerId, agentId, onChange) {
  currentAgentId = agentId;
  sessionContainerId = containerId;
  onChangeCallback = onChange;
  const container = document.getElementById(containerId);
  container.innerHTML = `
    <select id="session-select">
      <option value="${NEW_SESSION_VALUE}">+ 新建 session</option>
    </select>
  `;
  const sel = container.querySelector('select');
  sel.addEventListener('change', () => {
    const value = sel.value;
    if (value === NEW_SESSION_VALUE) {
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
  if (!sessionContainerId) return;
  const container = document.getElementById(sessionContainerId);
  const sel = container?.querySelector('select');
  if (!sel) return;
  await loadSessions(agentId, sel);
}

async function loadSessions(agentId, sel) {
  sel = sel || document.getElementById('session-select');
  if (!sel) return;
  const newOpt = `<option value="${NEW_SESSION_VALUE}">+ 新建 session</option>`;
  try {
    const data = await fetchSessions(agentId);
    const sessions = data?.sessions || [];
    if (sessions.length === 0) {
      sel.innerHTML = newOpt;
      return;
    }
    sel.innerHTML = newOpt + sessions.map(s => {
      const label = s.key.split(':').pop();
      return `<option value="${s.key}">${label}</option>`;
    }).join('');
  } catch (err) {
    console.warn('[sessions] load failed:', err);
    sel.innerHTML = newOpt;
  }
}

export function getSessionKey() { return currentSessionKey; }

export function clearSessionKey() { currentSessionKey = null; }
