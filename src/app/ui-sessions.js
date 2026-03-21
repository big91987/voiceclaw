// src/app/ui-sessions.js — session selector dropdown
import { fetchSessions, emitSessionChange } from './api.js';

let onChangeCallback = null;
let currentSessionKey = null;
let currentAgentId = null;
let sessionContainerId = null;
let selElement = null;

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
  selElement.addEventListener('change', () => {
    const value = selElement.value;
    currentSessionKey = value || null;
    onChangeCallback?.(currentSessionKey);
    emitSessionChange(currentSessionKey);
  });
  document.getElementById('btn-new-session').addEventListener('click', () => {
    selElement.value = '';
    currentSessionKey = null;
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

async function loadSessions(agentId) {
  if (!selElement) return;
  const newOpt = '<option value="">— 选择 session —</option>';
  try {
    const data = await fetchSessions(agentId);
    const sessions = data?.sessions || [];
    if (sessions.length === 0) {
      selElement.innerHTML = newOpt;
      return;
    }
    selElement.innerHTML = newOpt + sessions.map(s => {
      const label = s.key.split(':').pop();
      return `<option value="${s.key}">${label}</option>`;
    }).join('');
  } catch (err) {
    console.warn('[sessions] load failed:', err);
    selElement.innerHTML = newOpt;
  }
}

export function getSessionKey() { return currentSessionKey; }

export function clearSessionKey() { currentSessionKey = null; }
