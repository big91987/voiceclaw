// src/app/main.js — entry point: wires all modules together
import { connectEvents, on, streamChat, emitSessionChange, getOpenClawPath } from './api.js';
import { initAgentSelector, getAgentId } from './ui-agents.js';
import { initChat, sendMessage, getCurrentSessionKey, appendMessage } from './ui-chat.js';
import { initTasks, createThinkingBubble } from './ui-tasks.js';
import { initSessionSelector, getSessionKey, getResolvedSessionKey, getSessionKeyForId, clearSessionKey, refreshSessions } from './ui-sessions.js';
import { startDictation, stopDictation, speak, stopSpeaking, startCall, stopCall } from './voice.js';
import { initSettingsTab } from './ui-settings.js';
import { getSetting } from './settings.js';

// ── Status dot ─────────────────────────────────────────────
const dot = document.getElementById('status-dot');
connectEvents();
on('gateway-event', (e) => {
  if (e.type === 'connected') dot.className = 'dot dot--on';
});

// ── Tab switching ──────────────────────────────────────────
let currentTab = 'chat';

function switchTab(tab) {
  currentTab = tab;
  const chatArea = document.getElementById('chat-area');
  const settingsPanel = document.getElementById('settings-panel');
  const tabChat = document.getElementById('tab-chat');
  const tabSettings = document.getElementById('tab-settings');

  if (tab === 'chat') {
    chatArea.classList.remove('hidden');
    settingsPanel.classList.add('hidden');
    tabChat.classList.add('tab-btn--active');
    tabSettings.classList.remove('tab-btn--active');
  } else {
    chatArea.classList.add('hidden');
    settingsPanel.classList.remove('hidden');
    tabChat.classList.remove('tab-btn--active');
    tabSettings.classList.add('tab-btn--active');
  }
}

document.getElementById('tab-chat').addEventListener('click', () => switchTab('chat'));
document.getElementById('tab-settings').addEventListener('click', () => switchTab('settings'));

// ── Settings Tab ─────────────────────────────────────────
initSettingsTab((newPath) => {
  const agentId = getAgentId();
  if (agentId) refreshSessions(agentId);
});

// ── Agent selector ─────────────────────────────────────────
initAgentSelector('agent-selector', async (id) => {
  clearSessionKey();
  emitSessionChange(null); // 通知 tasks 清空当前 session
  initTasks(id);
  await refreshSessions(id);
});

initSessionSelector('session-selector', getAgentId(), (sessionKey) => {
  if (sessionKey === null) {
    document.getElementById('messages').innerHTML = '';
  }
});

// ── Chat ───────���───────────────────────────────────────────
initChat((key) => {
  // Refresh tasks when a new session key appears
  const agentId = getAgentId();
  if (agentId) initTasks(agentId);
});

const textInput = document.getElementById('text-input');
const btnSend   = document.getElementById('btn-send');

async function handleSend() {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  textInput.style.height = '';
  // Historical sessions: use the resolved gateway session key
  // (resolveSessionKey is awaited in the dropdown change handler, so it should be ready)
  const selectedId = getSessionKey();
  const sessionKey = selectedId ? getResolvedSessionKey() : getCurrentSessionKey();
  await sendMessage({
    text,
    agentId: getAgentId(),
    reuseSession: true,
    sessionKey,
  });
}

btnSend.addEventListener('click', handleSend);
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
});
textInput.addEventListener('input', () => {
  textInput.style.height = '';
  textInput.style.height = Math.min(textInput.scrollHeight, 120) + 'px';
});

// ── Dictation ──────────────────────────────────────────────
const btnDictate = document.getElementById('btn-dictate');
let dictating = false;

btnDictate.addEventListener('click', async () => {
  if (dictating) {
    stopDictation();
    btnDictate.textContent = '🎤';
    btnDictate.classList.remove('active');
    dictating = false;
    return;
  }
  dictating = true;
  btnDictate.textContent = '⏹';
  btnDictate.classList.add('active');
  await startDictation(
    (partial) => { textInput.value = partial; },
    (final)   => {
      textInput.value = final;
      btnDictate.textContent = '🎤';
      btnDictate.classList.remove('active');
      dictating = false;
    },
  );
});

// ── Call mode ──────────────────────────────────────────────
const btnCall    = document.getElementById('btn-call');
const btnHangup  = document.getElementById('btn-hangup');
const inputNormal = document.getElementById('input-normal');
const inputCall   = document.getElementById('input-call');
const callInitHint = document.getElementById('call-init-hint');
const callReadyArea = document.getElementById('call-ready-area');
let inCall = false;

function showCallReady() {
  callInitHint.classList.add('hidden');
  callReadyArea.classList.remove('hidden');
}

function resetCallUI() {
  callInitHint.classList.remove('hidden');
  callReadyArea.classList.add('hidden');
}

btnCall.addEventListener('click', async () => {
  if (inCall) return;
  inCall = true;
  inputNormal.classList.add('hidden');
  inputCall.classList.remove('hidden');
  btnCall.classList.add('active');
  resetCallUI(); // show "初始化中…" every time call starts

  let currentAc = null;
  let currentRunId = null;
  let currentSessionKey = null;
  let callSessionKey = getCurrentSessionKey(); // sticky session across call turns
  let generation = 0;

  await startCall(
    async (text) => {
      // Voice final → send to agent, stream reply, speak it
      const myGeneration = ++generation;
      appendMessage('user', text);

      const agentId = getAgentId();
      if (!agentId) {
        const err = appendMessage('assistant', '[错误] 未选择 Agent');
        err.style.color = 'var(--danger)';
        return;
      }

      // TTS queue: speak segments in order without blocking stream consumption
      const ttsQueue = [];
      let ttsBusy = false;
      async function flushTts() {
        if (ttsBusy) return;
        while (ttsQueue.length > 0) {
          if (myGeneration !== generation) { ttsQueue.length = 0; return; }
          ttsBusy = true;
          const seg = ttsQueue.shift();
          await speak(seg).catch(() => {});
          ttsBusy = false;
        }
      }
      function enqueueTts(seg) {
        if (!seg) return;
        ttsQueue.push(seg);
        flushTts();
      }

      // Current text bubble state
      let thinking = appendMessage('assistant', '...');
      thinking.classList.add('msg--thinking');
      thinking.dataset.currentTurn = '1';
      let reply = '';
      let callThinkingBubble = null;

      function finalizeCallThinkingBubble() {
        if (!callThinkingBubble) return;
        callThinkingBubble.dot.className = 'tool-dot done';
        callThinkingBubble.nameEl.textContent = '已思考';
        callThinkingBubble = null;
      }

      // Commit current bubble: freeze it, TTS the text, return a fresh thinking bubble
      function commitSegment() {
        if (reply) {
          thinking.className = 'msg msg--assistant';
          delete thinking.dataset.currentTurn;
          enqueueTts(reply);
        } else if (thinking.parentNode) {
          thinking.remove();
        }
        // New thinking bubble for next text segment
        thinking = appendMessage('assistant', '...');
        thinking.classList.add('msg--thinking');
        thinking.dataset.currentTurn = '1';
        reply = '';
      }

      const ac = new AbortController();
      currentAc = ac;

      try {
        for await (const ev of streamChat({
          message: text,
          agentId,
          sessionKey: callSessionKey,
          reuseSession: true,
          queueMode: getSetting('callQueueMode'),
          signal: ac.signal,
        })) {
          if (myGeneration !== generation) break; // barged-in, discard
          if (ev.done) break;
          // Track the run so barge-in can abort it
          if (ev.type === 'metric' && ev.metric === 'session_start') {
            currentRunId = ev.runId;
            currentSessionKey = ev.sessionKey;
            if (!callSessionKey) callSessionKey = ev.sessionKey;
          }
          // Thinking stream
          if (ev.event === 'agent' && ev.payload?.stream === 'thinking') {
            if (getSetting('showThinking')) {
              const raw = ev.payload?.data?.text;
              if (typeof raw === 'string' && raw) {
                if (!callThinkingBubble) {
                  callThinkingBubble = createThinkingBubble();
                  const turnEl = document.getElementById('messages').querySelector('[data-current-turn]');
                  if (turnEl) document.getElementById('messages').insertBefore(callThinkingBubble.wrap, turnEl);
                  else document.getElementById('messages').appendChild(callThinkingBubble.wrap);
                }
                const stripped = raw.replace(/^Reasoning:\n/i, '').replace(/^_|_$/gm, '');
                callThinkingBubble.content.textContent = stripped;
              }
            }
          }
          // Tool start → finalize thinking bubble, commit current text segment
          if (ev.event === 'agent' && ev.payload?.stream === 'tool' && ev.payload?.data?.phase === 'start') {
            finalizeCallThinkingBubble();
            commitSegment();
          }
          // Assistant delta
          if (ev.event === 'agent' && ev.payload?.stream === 'assistant') {
            const d = ev.payload?.data?.delta;
            if (d) {
              finalizeCallThinkingBubble();
              if (thinking.classList.contains('msg--thinking')) {
                thinking.className = 'msg msg--assistant';
                thinking.textContent = '';
              }
              reply += d;
              thinking.textContent = reply;
              document.getElementById('messages').scrollTop = 9999;
            }
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error('[call] streamChat error:', err);
          thinking.className = 'msg msg--assistant';
          thinking.textContent = `[错误] ${err.message}`;
          thinking.style.color = 'var(--danger)';
          delete thinking.dataset.currentTurn;
          return;
        }
      }

      currentAc = null;
      currentRunId = null;
      finalizeCallThinkingBubble();

      // Stale check: barge-in happened during this turn
      if (myGeneration !== generation) {
        if (thinking.parentNode) {
          thinking.className = 'msg msg--assistant';
          thinking.textContent = (reply || '...') + '（被打断）';
          delete thinking.dataset.currentTurn;
        }
        return;
      }

      // Commit final segment
      delete thinking.dataset.currentTurn;
      if (reply) {
        thinking.className = 'msg msg--assistant';
        enqueueTts(reply);
      } else if (thinking.parentNode) {
        thinking.remove();
      }
    },
    async () => {
      // barge-in: bump generation, abort gateway run + SSE stream + TTS
      generation++;
      stopSpeaking();
      if (currentRunId && currentSessionKey) {
        try {
          await fetch('/api/chat/abort', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId: currentRunId, sessionKey: currentSessionKey }),
          });
        } catch {}
      }
      currentAc?.abort();
    },
    () => {
      // onReady: ASR initialized, show waveform
      showCallReady();
    },
  );
});

btnHangup.addEventListener('click', () => {
  inCall = false;
  stopCall();
  stopSpeaking();
  inputCall.classList.add('hidden');
  inputNormal.classList.remove('hidden');
  btnCall.classList.remove('active');
  resetCallUI();
});
