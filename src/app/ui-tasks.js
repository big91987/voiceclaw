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

// tool call bubble state: toolCallId → { wrap, dot, status, detail, cachedArgs }
const toolCallMap = new Map();
const messagesEl = document.getElementById('messages');

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

function createToolBubble(toolCallId, name) {
  const wrap = document.createElement('div');
  wrap.className = 'msg--tool';
  wrap.dataset.toolCallId = toolCallId;

  const summary = document.createElement('div');
  summary.className = 'tool-summary';

  const dot = document.createElement('div');
  dot.className = 'tool-dot running';

  const nameEl = document.createElement('span');
  nameEl.className = 'tool-name';
  nameEl.textContent = name;

  const status = document.createElement('span');
  status.className = 'tool-status';
  status.textContent = '运行中…';

  summary.append(dot, nameEl, status);

  const detail = document.createElement('div');
  detail.className = 'tool-detail';
  detail.hidden = true;

  summary.addEventListener('click', () => {
    detail.hidden = !detail.hidden;
  });

  wrap.append(summary, detail);
  return { wrap, dot, status, detail };
}

// Static tool bubble for history replay
export function appendStaticToolBubble(name, args, result) {
  const { wrap, dot, status, detail } = createToolBubble('history-' + name + '-' + Date.now(), name);
  dot.className = 'tool-dot done';
  status.textContent = '完成 · 点击展开';
  const argsDiv = document.createElement('div');
  argsDiv.className = 'tool-detail-args';
  argsDiv.textContent = args !== undefined ? 'args: ' + JSON.stringify(args, null, 2) : '';
  const resultDiv = document.createElement('div');
  resultDiv.className = 'tool-detail-result';
  resultDiv.textContent = result !== undefined ? '\nresult: ' + (typeof result === 'string' ? result : JSON.stringify(result, null, 2)) : '';
  detail.append(argsDiv, resultDiv);
  if (messagesEl) messagesEl.appendChild(wrap);
}

// Second on('agent-event') handler for tool stream — safe to register alongside the lifecycle handler above
on('agent-event', (event) => {
  const payload = event.payload || {};

  const data = payload.data || {};
  const { toolCallId, name, phase, args, result } = data;
  if (!toolCallId) return;

  if (phase === 'start') {
    const els = createToolBubble(toolCallId, name);
    // cache args from start event — result event may not carry them
    toolCallMap.set(toolCallId, { ...els, cachedArgs: args });
    if (messagesEl) {
      // insert before the current-turn assistant bubble so tools appear above the reply
      const turnEl = messagesEl.querySelector('[data-current-turn]');
      if (turnEl) {
        messagesEl.insertBefore(els.wrap, turnEl);
      } else {
        messagesEl.appendChild(els.wrap);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  } else if (phase === 'result') {
    const els = toolCallMap.get(toolCallId);
    if (!els) return;

    // update status indicator
    els.dot.className = 'tool-dot done';
    els.status.textContent = '完成 · 点击展开';

    // fill detail (use args cached from start event)
    const argsText = els.cachedArgs !== undefined
      ? 'args: ' + JSON.stringify(els.cachedArgs, null, 2)
      : '';
    const resultText = result !== undefined
      ? '\nresult: ' + (typeof result === 'string' ? result : JSON.stringify(result, null, 2))
      : '';

    const argsDiv = document.createElement('div');
    argsDiv.className = 'tool-detail-args';
    argsDiv.textContent = argsText;

    const resultDiv = document.createElement('div');
    resultDiv.className = 'tool-detail-result';
    resultDiv.textContent = resultText;

    els.detail.append(argsDiv, resultDiv);
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;

    // release map entry to avoid unbounded growth
    toolCallMap.delete(toolCallId);
  }
});
