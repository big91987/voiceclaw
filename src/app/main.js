// src/app/main.js — entry point: wires all modules together
import { connectEvents, on, streamChat, emitSessionChange, getOpenClawPath } from './api.js';
import { initAgentSelector, getAgentId } from './ui-agents.js';
import { initChat, sendMessage, getCurrentSessionKey, appendMessage } from './ui-chat.js';
import { initTasks } from './ui-tasks.js';
import { initSessionSelector, getSessionKey, getResolvedSessionKey, getSessionKeyForId, clearSessionKey, refreshSessions } from './ui-sessions.js';
import { startDictation, stopDictation, speak, stopSpeaking, startCall, stopCall } from './voice.js';
import { initSettingsTab } from './ui-settings.js';

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
let inCall = false;

btnCall.addEventListener('click', async () => {
  if (inCall) return;
  inCall = true;
  inputNormal.classList.add('hidden');
  inputCall.classList.remove('hidden');
  btnCall.classList.add('active');

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
      let reply = '';
      const thinking = appendMessage('assistant', '...');
      thinking.classList.add('msg--thinking');
      const ac = new AbortController();
      currentAc = ac;

      try {
        for await (const ev of streamChat({
          message: text,
          agentId: getAgentId(),
          sessionKey: callSessionKey,
          reuseSession: true,
          queueMode: 'interrupt',
          signal: ac.signal,
        })) {
          if (myGeneration !== generation) break; // barged-in, discard
          if (ev.done) break;
          // Track the run so barge-in can abort it
          if (ev.type === 'metric' && ev.metric === 'session_start') {
            currentRunId = ev.runId;
            currentSessionKey = ev.sessionKey;
            if (!callSessionKey) callSessionKey = ev.sessionKey; // sticky for subsequent turns
          }
          if (ev.event === 'agent' && ev.payload?.stream === 'assistant') {
            const d = ev.payload?.data?.delta;
            if (d) {
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
        if (err.name !== 'AbortError') console.error('[call] streamChat error:', err);
      }

      currentAc = null;
      currentRunId = null;

      // Stale check: barge-in happened during this turn
      if (myGeneration !== generation) {
        if (thinking.parentNode) {
          thinking.classList.remove('msg--thinking');
          thinking.className = 'msg msg--assistant';
          thinking.textContent = (reply || '...') + '（被打断）';
        }
        return;
      }
      if (!reply && thinking.parentNode) thinking.remove();
      if (reply) await speak(reply);
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
  );
});

btnHangup.addEventListener('click', () => {
  inCall = false;
  stopCall();
  stopSpeaking();
  inputCall.classList.add('hidden');
  inputNormal.classList.remove('hidden');
  btnCall.classList.remove('active');
});
