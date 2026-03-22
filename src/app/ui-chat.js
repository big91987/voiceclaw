// src/app/ui-chat.js — conversation messages + streaming assistant replies
import { streamChat, fetchChatHistory, getOpenClawPath, on } from './api.js';

const messagesEl = document.getElementById('messages');
let currentSessionKey = null;
let onSessionKeyCallback = null;

export function initChat(onSessionKey) {
  onSessionKeyCallback = onSessionKey;

  // Load history when session changes
  on('session-change', async (sessionId) => {
    currentSessionKey = sessionId;
    messagesEl.innerHTML = '';
    if (sessionId) {
      const agentId = document.getElementById('agent-select')?.value;
      if (agentId) await loadHistory(agentId, sessionId);
    }
  });
}

async function loadHistory(agentId, sessionId) {
  try {
    const openclawPath = getOpenClawPath();
    const data = await fetchChatHistory(agentId, sessionId, openclawPath);
    const messages = data?.messages || [];
    for (const msg of messages) {
      const content = msg.content;
      const text = Array.isArray(content) ? content.find(c => c.type === 'text')?.text : (typeof content === 'string' ? content : '');
      if (text) appendMessage(msg.role, text);
    }
  } catch (e) {
    console.warn('[chat] load history failed:', e);
  }
}

export function getCurrentSessionKey() { return currentSessionKey; }

export function clearSessionKey() { currentSessionKey = null; }

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

  const thinking = appendMessage('thinking', '...');
  thinking.classList.add('msg--thinking');
  let fullText = '';

  try {
    for await (const event of streamChat({ message: text, agentId, sessionKey, reuseSession, queueMode })) {
      if (event.done) break;

      // Track sessionKey from first metric event
      if (event.type === 'metric' && event.metric === 'session_start' && !currentSessionKey) {
        currentSessionKey = event.sessionKey;
        onSessionKeyCallback?.(currentSessionKey);
      }

      // Stream assistant text
      if (event.event === 'agent' && event.payload?.stream === 'assistant') {
        const delta = event.payload?.data?.delta;
        if (typeof delta === 'string' && delta) {
          if (thinking.classList.contains('msg--thinking')) {
            thinking.className = 'msg msg--assistant';
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
    return;
  }

  if (!fullText && thinking.parentNode) {
    thinking.remove();
  }
}
