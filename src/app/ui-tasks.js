// src/app/ui-tasks.js — task board sidebar with real-time session tree
import { fetchSessions, on } from './api.js';

const panel = document.getElementById('tasks-panel');
const toggleBtn = document.getElementById('tasks-toggle');
const sidebar = document.getElementById('tasks-sidebar');

// sessionKey → { key, spawnedBy, status, preview, children[] }
const nodes = new Map();
let currentAgentId = null;
let currentSessionKey = null;
let sidebarOpen = false;

// Listen to session changes from ui-sessions
on('session-change', (sessionKey) => {
  setCurrentSession(sessionKey);
});

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

export function setCurrentSession(sessionKey) {
  currentSessionKey = sessionKey;
}

export async function refreshTasks() {
  await refresh();
}

async function refresh() {
  try {
    const data = await fetchSessions(currentAgentId);
    const sessions = data?.sessions || [];
    nodes.clear();
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
      refresh();
    } else if (phase === 'error') {
      upsertNode(key, { key, status: 'error' });
      render();
    }
  }
});

const STATUS_ICON = { running: '⚡', done: '✓', error: '✗', aborted: '↩', idle: '—' };

function renderNode(node, depth) {
  const div = document.createElement('div');
  div.className = `task-node task-node--${node.status || 'idle'}`;
  div.style.marginLeft = depth * 12 + 'px';
  const icon = STATUS_ICON[node.status] || '—';
  const label = (node.preview || node.key).slice(0, 60);
  div.textContent = `${icon} ${label}`;
  div.title = node.key;
  return div;
}

function render() {
  panel.innerHTML = '';

  // Build parent→children links
  for (const node of nodes.values()) node.children = [];
  const roots = [];

  if (currentSessionKey) {
    // B mode: show selected session + its children
    const target = nodes.get(currentSessionKey);
    if (target) {
      // Add all descendants
      function addDescendants(key) {
        roots.push(nodes.get(key));
        for (const [k, n] of nodes) {
          if (n.spawnedBy === key) addDescendants(k);
        }
      }
      addDescendants(currentSessionKey);
    }
  } else {
    // A mode: show all sessions as roots (no parent) + orphaned children
    for (const node of nodes.values()) {
      if (node.spawnedBy && nodes.has(node.spawnedBy)) {
        nodes.get(node.spawnedBy).children.push(node.key);
      } else {
        roots.push(node);
      }
    }
  }

  // Sort: running first
  roots.sort((a, b) => (a.status === 'running' ? -1 : b.status === 'running' ? 1 : 0));

  function renderTree(node, depth) {
    panel.appendChild(renderNode(node, depth));
    (node.children || []).forEach(c => {
      const child = nodes.get(c);
      if (child) renderTree(child, depth + 1);
    });
  }

  roots.forEach(r => renderTree(r, 0));
}
