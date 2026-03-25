// src/app/ui-chat.js — conversation messages + streaming assistant replies
import { streamChat, fetchChatHistory, getOpenClawPath, on } from './api.js';
import { appendStaticToolBubble, createThinkingBubble, appendStaticThinkingBubble } from './ui-tasks.js';
import { getSetting } from './settings.js';

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

    // Build toolCallId → result text map from toolResult messages
    const toolResults = new Map();
    for (const msg of messages) {
      if (msg.role === 'toolResult' && msg.toolCallId) {
        const content = msg.content;
        const text = Array.isArray(content)
          ? content.find(c => c.type === 'text')?.text
          : (typeof content === 'string' ? content : undefined);
        toolResults.set(msg.toolCallId, text);
      }
    }

    for (const msg of messages) {
      if (msg.role === 'toolResult') continue; // rendered via toolCall pairing

      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            appendMessage(msg.role, block.text);
          } else if (block.type === 'toolCall') {
            const result = toolResults.get(block.id);
            appendStaticToolBubble(block.name, block.arguments, result);
          } else if (block.type === 'thinking') {
            const text = block.thinking || block.text;
            if (text) appendStaticThinkingBubble(text);
          }
        }
      } else if (typeof content === 'string' && content) {
        appendMessage(msg.role, content);
      }
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
  thinking.dataset.currentTurn = '1';  // marker so tool bubbles can insert before it
  let fullText = '';

  // Thinking bubble for reasoning stream
  let thinkingBubble = null;

  function getOrCreateThinkingBubble() {
    if (!thinkingBubble) {
      thinkingBubble = createThinkingBubble();
      const turnEl = messagesEl.querySelector('[data-current-turn]');
      if (turnEl) messagesEl.insertBefore(thinkingBubble.wrap, turnEl);
      else messagesEl.appendChild(thinkingBubble.wrap);
    }
    return thinkingBubble;
  }

  function finalizeThinkingBubble(tb) {
    tb.dot.className = 'tool-dot done';
    tb.nameEl.textContent = '已思考';
  }

  try {
    for await (const event of streamChat({ message: text, agentId, sessionKey, reuseSession, queueMode })) {
      if (event.done) break;

      // Track sessionKey from first metric event
      if (event.type === 'metric' && event.metric === 'session_start' && !currentSessionKey) {
        currentSessionKey = event.sessionKey;
        onSessionKeyCallback?.(currentSessionKey);
      }

      // Reasoning/thinking stream
      if (event.event === 'agent' && event.payload?.stream === 'thinking') {
        if (!getSetting('showThinking')) continue;
        const raw = event.payload?.data?.text;
        if (typeof raw === 'string' && raw) {
          if (thinkingBubble) { finalizeThinkingBubble(thinkingBubble); thinkingBubble = null; }
          const tb = getOrCreateThinkingBubble();
          // Strip "Reasoning:\n" prefix and "_..._" markdown italics
          const stripped = raw
            .replace(/^Reasoning:\n/i, '')
            .replace(/^_|_$/gm, '');
          tb.content.textContent = stripped;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      }

      // Tool call start — finalize current thinking bubble so each phase gets its own
      if (event.event === 'agent' && event.payload?.stream === 'tool' &&
          event.payload?.data?.phase === 'start') {
        if (thinkingBubble) { finalizeThinkingBubble(thinkingBubble); thinkingBubble = null; }
      }

      // Stream assistant text
      if (event.event === 'agent' && event.payload?.stream === 'assistant') {
        const delta = event.payload?.data?.delta;
        if (typeof delta === 'string' && delta) {
          // Finalize thinking bubble once assistant text starts
          if (thinkingBubble) { finalizeThinkingBubble(thinkingBubble); thinkingBubble = null; }
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
  // Finalize thinking bubble if it wasn't closed by assistant text
  if (thinkingBubble) { finalizeThinkingBubble(thinkingBubble); }
  delete thinking.dataset.currentTurn;
}
