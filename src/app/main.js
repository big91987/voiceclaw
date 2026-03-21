// src/app/main.js — entry point: wires all modules together
import { connectEvents, on, streamChat, emitSessionChange } from './api.js';
import { initAgentSelector, getAgentId } from './ui-agents.js';
import { initChat, sendMessage, getCurrentSessionKey, appendMessage } from './ui-chat.js';
import { initTasks } from './ui-tasks.js';
import { initSessionSelector, getSessionKey, clearSessionKey, refreshSessions } from './ui-sessions.js';
import { startDictation, stopDictation, speak, stopSpeaking, startCall, stopCall } from './voice.js';

// ── Status dot ─────────────────────────────────────────────
const dot = document.getElementById('status-dot');
connectEvents();
on('gateway-event', (e) => {
  if (e.type === 'connected') dot.className = 'dot dot--on';
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
  await sendMessage({
    text,
    agentId: getAgentId(),
    reuseSession: true,
    sessionKey: getSessionKey() ?? getCurrentSessionKey(),
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

  await startCall(
    async (text) => {
      // Voice final → send to agent, stream reply, speak it
      appendMessage('user', text);
      let reply = '';
      const thinking = appendMessage('assistant', '...');
      thinking.classList.add('msg--thinking');

      try {
        for await (const ev of streamChat({
          message: text,
          agentId: getAgentId(),
          sessionKey: getCurrentSessionKey(),
          reuseSession: true,
          queueMode: 'interrupt',
        })) {
          if (ev.done) break;
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
      } catch {}

      if (!reply && thinking.parentNode) thinking.remove();
      if (reply) await speak(reply);
    },
    () => { /* barge-in: stopSpeaking already called inside voice.js */ },
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
