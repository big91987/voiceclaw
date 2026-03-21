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
    const newOpt = '<option value="__new__">+ 新建 session</option>';
    if (sessions.length === 0) {
      sel.innerHTML = newOpt;
      return;
    }
    const sessionOpts = sessions.map(s => {
      const label = s.key.split(':').pop();
      return `<option value="${s.key}">${label}</option>`;
    }).join('');
    sel.innerHTML = newOpt + sessionOpts;
  } catch {
    sel.innerHTML = newOpt;
  }
}

export function getSessionKey() { return currentSessionKey; }

export function clearSessionKey() { currentSessionKey = null; }
