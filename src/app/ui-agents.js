// src/app/ui-agents.js — agent selector dropdown
import { fetchAgents } from './api.js';

let onChangeCallback = null;
let currentAgentId = null;

export function initAgentSelector(containerId, onChange) {
  onChangeCallback = onChange;
  const el = document.getElementById(containerId);
  el.innerHTML = '<select id="agent-select"></select>';
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
    sel.innerHTML = agents.map(a => `<option value="${a.id}">${a.id}</option>`).join('');
    if (agents.length > 0) {
      currentAgentId = agents[0].id;
      onChangeCallback?.(currentAgentId);
    }
  } catch {
    sel.innerHTML = '<option value="voice">voice</option>';
    currentAgentId = 'voice';
    onChangeCallback?.('voice');
  }
}

export function getAgentId() { return currentAgentId; }
