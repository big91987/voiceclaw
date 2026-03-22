// src/app/voice.js — mic capture, ASR dictation, TTS playback, call mode waveforms
let asrWs = null;
let audioCtx = null;
let processor = null;
let micStream = null;
let vadThreshold = 0.01; // raised during TTS to reduce echo

export function setVadThreshold(v) { vadThreshold = v; }

async function openMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }
  });
  audioCtx = new AudioContext({ sampleRate: 16000 });
  const src = audioCtx.createMediaStreamSource(micStream);
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  src.connect(processor);
  processor.connect(audioCtx.destination);
  return processor;
}

function closeMic() {
  processor?.disconnect();
  micStream?.getTracks().forEach(t => t.stop());
  audioCtx?.close();
  processor = null; micStream = null; audioCtx = null;
}

function connectAsrWs(onMessage) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/asr`);
  console.log('[voice] ASR WS connecting to', ws.url);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => console.log('[voice] ASR WS open');
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch { console.log('[voice] ASR parse error', e.data); } };
  ws.onerror = (e) => console.log('[voice] ASR WS error', e);
  ws.onclose = (e) => {
    console.log('[voice] ASR WS close', e.code, e.reason);
    // Auto-reconnect if still in call
    if (calling) {
      console.log('[voice] ASR WS reconnecting...');
      asrWs = connectAsrWs(onMessage);
    }
  };
  return ws;
}

// ── Dictation mode ─────────────────────────────────────────
let dictating = false;

export async function startDictation(onPartial, onFinal) {
  if (dictating) return;
  dictating = true;
  asrWs = connectAsrWs((msg) => {
    if (msg.type === 'partial') onPartial(msg.text);
    if (msg.type === 'final')   { onFinal(msg.text); stopDictation(); }
  });
  const proc = await openMic();
  proc.onaudioprocess = (e) => {
    if (!dictating || asrWs?.readyState !== 1) return;
    const f32 = e.inputBuffer.getChannelData(0);
    const rms = Math.sqrt(f32.reduce((s, v) => s + v * v, 0) / f32.length);
    if (rms < vadThreshold) return;
    const pcm = new Int16Array(f32.length);
    f32.forEach((v, i) => pcm[i] = Math.max(-32768, Math.min(32767, v * 32768)));
    asrWs.send(pcm.buffer);
  };
}

export function stopDictation() {
  dictating = false;
  asrWs?.close(); asrWs = null;
  closeMic();
}

// ── TTS playback ───────────────────────────────────────────
let ttsAudio = null;

export async function speak(text) {
  stopSpeaking();
  setVadThreshold(0.03);
  const r = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  ttsAudio = new Audio(url);
  ttsAudio.onended = () => { setVadThreshold(0.01); URL.revokeObjectURL(url); ttsAudio = null; };
  ttsAudio.play();
  return ttsAudio;
}

export function stopSpeaking() {
  if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
  setVadThreshold(0.01);
}

export function isSpeaking() { return !!ttsAudio && !ttsAudio.paused; }

// ── Call mode ──────────────────────────────────────────────
let calling = false;
let partialEl = null; // current partial message element
let partialText = '';

const canvasUser  = document.getElementById('wave-user');
const canvasAgent = document.getElementById('wave-agent');
const ctxUser  = canvasUser?.getContext('2d');
const ctxAgent = canvasAgent?.getContext('2d');

export async function startCall(onFinal, onBargeIn) {
  if (calling) return;
  calling = true;

  asrWs = connectAsrWs((msg) => {
    console.log('[voice] ASR msg:', JSON.stringify(msg));
    if (msg.type === 'barge_in') { stopSpeaking(); onBargeIn?.(); }
    if (msg.type === 'partial') {
      console.log('[voice] partial:', msg.text);
      partialText = msg.text;
      const messagesEl = document.getElementById('messages');
      if (!partialEl) {
        partialEl = document.createElement('div');
        partialEl.className = 'msg msg--user';
        partialEl.textContent = msg.text;
        partialEl.setAttribute('data-partial', 'true');
        messagesEl.appendChild(partialEl);
      } else {
        partialEl.textContent = msg.text;
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    if (msg.type === 'final') {
      console.log('[voice] final:', msg.text);
      if (partialEl) { partialEl.remove(); partialEl = null; }
      const t = msg.text; partialText = '';
      onFinal(t);
    }
  });

  const proc = await openMic();
  const userLevels = new Float32Array(30);
  let idx = 0;

  proc.onaudioprocess = (e) => {
    if (!calling || asrWs?.readyState !== 1) return;
    const f32 = e.inputBuffer.getChannelData(0);
    const rms = Math.sqrt(f32.reduce((s, v) => s + v * v, 0) / f32.length);
    userLevels[idx++ % 30] = rms;
    drawWave(ctxUser, canvasUser, userLevels, '#4f9cf9');
    // Send ALL audio to ByteDance (including silence) so VAD works properly
    const pcm = new Int16Array(f32.length);
    f32.forEach((v, i) => pcm[i] = Math.max(-32768, Math.min(32767, v * 32768)));
    asrWs.send(pcm.buffer);
  };

  animateAgentWave();
}

export function stopCall() {
  calling = false;
  if (partialEl) { partialEl.remove(); partialEl = null; }
  partialText = '';
  asrWs?.close(); asrWs = null;
  closeMic();
  stopSpeaking();
  clearWave(ctxUser, canvasUser);
  clearWave(ctxAgent, canvasAgent);
}

function drawWave(ctx, canvas, levels, color) {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  const w = canvas.width / levels.length;
  levels.forEach((v, i) => {
    const h = Math.min(canvas.height, v * canvas.height * 8);
    ctx.fillRect(i * w, (canvas.height - h) / 2, w - 1, h);
  });
}

function clearWave(ctx, canvas) {
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

let agentWaveTimer = null;
const agentLevels = new Float32Array(30);
let agentIdx = 0;

function animateAgentWave() {
  if (agentWaveTimer) return;
  agentWaveTimer = setInterval(() => {
    if (!calling) { clearInterval(agentWaveTimer); agentWaveTimer = null; return; }
    agentLevels[agentIdx++ % 30] = isSpeaking() ? (Math.random() * 0.3 + 0.05) : 0.01;
    drawWave(ctxAgent, canvasAgent, agentLevels, '#52c878');
  }, 50);
}
