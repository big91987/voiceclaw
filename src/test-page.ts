import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { gzipSync, gunzipSync } from 'zlib';
import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import { config } from './config';

const kimiApiKey = 'sk-Oupbr9HRt6FUn2AAkzyntx7UR0BoDuudWQM0fTi1AOi9nanP';
const kimiBaseUrl = 'https://api.moonshot.cn';
const execFileAsync = promisify(execFile);

// ============ 多轮对话历史 ============
const MAX_HISTORY_ROUNDS = 100;
interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
const chatHistory: ChatMessage[] = [
  { role: 'system', content: '你是一个语音对话测试助手。回复简短自然，像跟人说话，不要太长。' }
];

function addToHistory(userMsg: string, assistantMsg: string) {
  chatHistory.push({ role: 'user', content: userMsg });
  chatHistory.push({ role: 'assistant', content: assistantMsg });
  // 保留system消息 + 最多MAX_HISTORY_ROUNDS轮对话（每轮2条）
  const maxMessages = 1 + MAX_HISTORY_ROUNDS * 2;
  while (chatHistory.length > maxMessages) {
    // 删除最早的一对对话（保留system）
    chatHistory.splice(1, 2);
  }
}

function getHistoryForApi(): ChatMessage[] {
  return [...chatHistory];
}

function json(res: http.ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function asrHeader(type: number, flag: number, serialization: number, compression: number) {
  const h = Buffer.alloc(4);
  h[0] = (1 << 4) | 1;
  h[1] = (type << 4) | flag;
  h[2] = (serialization << 4) | compression;
  h[3] = 0;
  return h;
}

function asrFullClientRequest(jsonObj: object) {
  const gz = gzipSync(Buffer.from(JSON.stringify(jsonObj)));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(gz.length, 0);
  return Buffer.concat([asrHeader(1, 0, 1, 1), len, gz]);
}

function asrAudioOnly(seq: number, bytes: Buffer) {
  const gz = gzipSync(bytes);
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(seq, 0);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(gz.length, 0);
  return Buffer.concat([asrHeader(2, 1, 0, 1), seqBuf, len, gz]);
}

function asrAudioOnlyLast(bytes: Buffer) {
  const gz = gzipSync(bytes);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(gz.length, 0);
  return Buffer.concat([asrHeader(2, 2, 0, 1), len, gz]);
}

function parseAsr(buf: Buffer) {
  const type = (buf[1] >> 4) & 0x0f;
  const flag = buf[1] & 0x0f;
  const compression = buf[2] & 0x0f;
  let offset = 4;
  let seq: number | null = null;
  let errCode: number | null = null;
  if ([9, 11, 12].includes(type) && [1, 2, 3].includes(flag)) {
    seq = buf.readInt32BE(offset); offset += 4;
  } else if (type === 15) {
    errCode = buf.readUInt32BE(offset); offset += 4;
  }
  const len = buf.readUInt32BE(offset); offset += 4;
  let payload = buf.slice(offset, offset + len);
  if (compression === 1) payload = gunzipSync(payload);
  return { type, flag, seq, errCode, payload: payload.toString('utf8') };
}

// ============ 句子缓冲：流式切分 LLM 输出 ============
class SentenceBuffer {
  private buffer = '';
  private minLength = 1;  // 降低为1，短句子也能触发
  private maxLength = 40;
  private flushTimeout = 100;  // 加快flush
  private timer: NodeJS.Timeout | null = null;
  private onSentence: (text: string) => void;

  constructor(onSentence: (text: string) => void) {
    this.onSentence = onSentence;
  }

  push(text: string): void {
    this.buffer += text;
    this.resetTimer();

    // 检查是否达到最大长度
    while (this.buffer.length >= this.maxLength) {
      // 找最大长度范围内的最后一个标点
      const cutPoint = this.findCutPoint(this.maxLength);
      if (cutPoint > this.minLength) {
        this.flushAt(cutPoint);
      } else {
        // 没找到合适标点，强制在 maxLength 处切断
        this.flushAt(this.maxLength);
      }
    }

    // 检查是否有完整句子（有标点且超过最小长度）
    const endPunct = /[。！？.!?]/;
    const match = this.buffer.match(new RegExp(`^[\\s\\S]{${this.minLength},}?[${endPunct.source}]`));
    if (match) {
      this.flushAt(match[0].length);
    }
  }

  private findCutPoint(maxLen: number): number {
    const endPunct = /[。！？.!?，,；;]/;
    for (let i = Math.min(maxLen, this.buffer.length); i > this.minLength; i--) {
      if (endPunct.test(this.buffer[i - 1])) {
        return i;
      }
    }
    return 0;
  }

  private flushAt(length: number): void {
    const sentence = this.buffer.slice(0, length).trim();
    this.buffer = this.buffer.slice(length).trimStart();
    if (sentence) {
      this.onSentence(sentence);
    }
  }

  private resetTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.buffer.length >= this.minLength) {
        this.flush();
      }
    }, this.flushTimeout);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.trim()) {
      this.onSentence(this.buffer.trim());
      this.buffer = '';
    }
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.buffer = '';
  }
}

// ============ 流式 LLM：边生成边送句子缓冲 ============
async function streamChatWithKimi(
  text: string,
  onToken: (token: string) => void,
  onSentence: (sentence: string) => void
): Promise<string> {
  console.log('[TEST] kimi stream input=', JSON.stringify(text));
  const sentenceBuffer = new SentenceBuffer(onSentence);

  try {
    const response = await fetch(`${kimiBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${kimiApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'kimi-k2-turbo-preview',
        max_tokens: 256,
        stream: true,
        messages: [...getHistoryForApi(), { role: 'user', content: text }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[TEST] Kimi API error:', response.status, errorText.substring(0, 500));
      throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 200)}`);
    }
    if (!response.body) {
      throw new Error('No response body');
    }

    // node-fetch 返回的是 Node.js ReadableStream，需要适配
    const body = response.body as unknown as NodeJS.ReadableStream;
    const decoder = new TextDecoder();
    let buffer = '';
    let fullReply = '';

    return new Promise((resolve, reject) => {
      body.on('data', (chunk: Buffer) => {
        console.log('[TEST] LLM data chunk received, size:', chunk.length);
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') {
            console.log('[TEST] LLM stream [DONE] received');
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              fullReply += content;
              onToken(content);
              sentenceBuffer.push(content);
            }
          } catch (e) {
            console.error('[TEST] Failed to parse LLM data:', data.substring(0, 100));
          }
        }
      });

      body.on('end', () => {
        console.log('[TEST] LLM stream end, total length:', fullReply.length);
        sentenceBuffer.flush();
        resolve(fullReply);
      });

      body.on('error', (err) => {
        console.error('[TEST] LLM stream error:', err);
        reject(err);
      });
    });

  } catch (e: any) {
    console.error('[TEST] kimi stream error:', e);
    throw e;
  }
}

// ============ TTS：真流式，边合成边返回音频块 ============
// ============ TTS 长连接管理 ============
class TtsConnection {
  private ws: WebSocket | null = null;
  private sessionId: string;
  private ready = false;
  private pendingQueue: { text: string; onChunk: (chunk: Buffer) => void; onDone: () => void; onError: (e: Error) => void }[] = [];
  private currentJob: { text: string; onChunk: (chunk: Buffer) => void; onDone: () => void; onError: (e: Error) => void } | null = null;
  private audioBuffer: Buffer[] = [];

  constructor() {
    this.sessionId = uuidv4();
    this.connect();
  }

  private connect() {
    this.ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/tts/bidirection', {
      headers: {
        'X-Api-App-Key': config.ttsAppId,
        'X-Api-Access-Key': config.ttsApiKey,
        'X-Api-Resource-Id': 'seed-tts-2.0',
        'X-Api-Connect-Id': uuidv4(),
      },
      skipUTF8Validation: true,
    });

    this.ws.on('open', () => {
      console.log('[TTS_CONN] WebSocket open');
      this.ws?.send(this.makeEvent(1, null, {}));
    });

    this.ws.on('message', (raw) => {
      const data = Buffer.from(raw as Buffer);
      const type = (data[1] >> 4) & 0x0f;
      const flag = data[1] & 0x0f;
      let offset = 4;
      let event: number | null = null;
      if (flag & 4) {
        event = data.readInt32BE(offset); offset += 4;
        if (event >= 100) {
          const sidLen = data.readUInt32BE(offset); offset += 4 + sidLen;
        }
      }
      const len = data.readUInt32BE(offset); offset += 4;
      const payload = data.slice(offset, offset + len);

      console.log(`[TTS_CONN] msg type=${type} flag=${flag} event=${event} payloadLen=${payload.length}`);

      if (type === 9 && event === 50) {
        // 服务端准备好，等待processQueue来创建session（避免重复创建）
        console.log('[TTS_CONN] server ready (50), waiting for job');
        this.ready = true;
        this.processQueue();
      } else if (type === 9 && event === 150) {
        // session 建立成功，发送文本和 finish
        console.log('[TTS_CONN] session ready, sending text');
        if (this.currentJob) {
          this.ws?.send(this.makeEvent(200, this.sessionId, {
            user: { uid: uuidv4() },
            req_params: { speaker: 'zh_female_vv_uranus_bigtts', text: (this.currentJob as any).text, audio_params: { format: 'mp3', sample_rate: 24000 } },
          }));
          this.ws?.send(this.makeEvent(102, this.sessionId, {}));
        }
      } else if (type === 11 || (type === 9 && event === 352)) {
        // 音频数据块 (type 11 或 event 352)
        console.log(`[TTS_CONN] audio chunk: ${payload.length} bytes`);
        this.currentJob?.onChunk(payload);
      } else if (type === 9 && event === 351) {
        // 服务端需要更多数据，忽略（我们已经在500ms后主动发了finish）
        console.log('[TTS_CONN] got 351 (ignored)');
      } else if (type === 9 && event === 152) {
        // 当前句子完成
        console.log('[TTS_CONN] session finished (152)');
        this.currentJob?.onDone();
        this.currentJob = null;
        this.processQueue();
      } else if (type === 15) {
        const err = new Error(payload.toString());
        this.currentJob?.onError(err);
        this.currentJob = null;
        this.processQueue();
      }
    });

    this.ws.on('error', (err) => {
      console.error('[TTS_CONN] WebSocket error:', err);
      this.currentJob?.onError(err as Error);
      this.currentJob = null;
    });

    this.ws.on('close', () => {
      console.log('[TTS_CONN] WebSocket closed, reconnecting...');
      this.ready = false;
      setTimeout(() => this.connect(), 1000);
    });
  }

  private makeEvent(event: number, sessionId: string | null, payload: object) {
    const payloadBuf = Buffer.from(JSON.stringify(payload));
    const eventBuf = Buffer.alloc(4); eventBuf.writeInt32BE(event, 0);
    const parts: Buffer[] = [this.header(1, 4, 1, 0), eventBuf];
    if (event >= 100 && sessionId) {
      const sid = Buffer.from(sessionId);
      const sidLen = Buffer.alloc(4); sidLen.writeUInt32BE(sid.length, 0);
      parts.push(sidLen, sid);
    }
    const len = Buffer.alloc(4); len.writeUInt32BE(payloadBuf.length, 0);
    parts.push(len, payloadBuf);
    return Buffer.concat(parts);
  }

  private header(type: number, flag: number, serialization: number, compression: number) {
    const h = Buffer.alloc(4);
    h[0] = (1 << 4) | 1;
    h[1] = (type << 4) | flag;
    h[2] = (serialization << 4) | compression;
    h[3] = 0;
    return h;
  }

  private processQueue() {
    console.log(`[TTS_CONN] processQueue: ready=${this.ready}, currentJob=${!!this.currentJob}, queueLen=${this.pendingQueue.length}`);
    if (!this.ready || this.currentJob || this.pendingQueue.length === 0) return;
    const job = this.pendingQueue.shift()!;
    console.log(`[TTS_CONN] starting synthesis: ${job.text.substring(0, 20)}`);
    this.currentJob = { text: job.text, onChunk: job.onChunk, onDone: job.onDone, onError: job.onError };
    // 每句新建 session（连接复用）
    this.sessionId = uuidv4();
    this.ws?.send(this.makeEvent(100, this.sessionId, {
      user: { uid: uuidv4() },
      req_params: { speaker: 'zh_female_vv_uranus_bigtts', audio_params: { format: 'mp3', sample_rate: 24000 } },
    }));
  }

  synthesize(text: string, onChunk: (chunk: Buffer) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('TTS timeout'));
      }, 30000);

      this.pendingQueue.push({
        text,
        onChunk,
        onDone: () => {
          clearTimeout(timeout);
          resolve();
        },
        onError: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      this.processQueue();
    });
  }

  close() {
    this.ws?.close();
  }
}

// 全局 TTS 连接
const globalTtsConn = new TtsConnection();

async function streamTTS(
  text: string,
  onAudioChunk: (chunk: Buffer) => void
): Promise<void> {
  console.log('[TEST] streamTTS:', text.substring(0, 30));
  return globalTtsConn.synthesize(text, onAudioChunk);
}

// ============ 流式 ASR Session ============
class StreamingAsrSession {
  private ws: WebSocket | null = null;
  private nextSeq = 2;
  private ready = false;
  private closed = false;
  private runningReply = false;
  private processedUtteranceIds = new Set<string>();
  private currentTurnText = '';
  private lastProcessedText = ''; // 跟踪上一轮处理过的文本，用于过滤累积

  constructor(
    private sendEvent: (data: unknown) => void,
    private onFinal: (text: string) => Promise<void>,
  ) {}

  start() {
    // 使用双向流式优化版，支持二遍识别+VAD分句
    this.ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async', {
      headers: {
        'X-Api-App-Key': config.asrAppId,
        'X-Api-Access-Key': config.asrApiKey,
        'X-Api-Resource-Id': 'volc.bigasr.sauc.duration',
        'X-Api-Connect-Id': uuidv4(),
      },
      skipUTF8Validation: true,
    });

    this.ws.on('open', () => {
      this.ws?.send(asrFullClientRequest({
        user: { uid: uuidv4() },
        audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1, language: 'zh-CN' },
        request: {
          model_name: 'bigmodel',
          enable_itn: true,
          enable_punc: true,
          show_utterances: true,  // 必须开启，才能看到 definite 标记
          end_window_size: 800,   // VAD判停时间(ms)，开启自动分句
        },
      }));
    });

    this.ws.on('message', async (raw) => {
      const msg = parseAsr(Buffer.from(raw as Buffer));
      if (msg.type === 15) {
        this.sendEvent({ type: 'error', error: msg.payload });
        return;
      }
      if (msg.type !== 9) return;

      try {
        const parsed = JSON.parse(msg.payload);
        console.log('[ASR] raw payload keys:', Object.keys(parsed));
        console.log('[ASR] result keys:', parsed?.result ? Object.keys(parsed.result) : 'no result');

        const text = parsed?.result?.text || '';
        const utterances: any[] = parsed?.result?.utterances || [];

        console.log('[ASR] utterances count:', utterances.length);
        if (utterances.length > 0) {
          console.log('[ASR] first utterance:', JSON.stringify(utterances[0]));
        }

        // 检查是否有 definite=true 的utterance（二遍识别完成）
        const definiteUtterances = utterances.filter((u: any) => u?.definite === true);
        const hasDefinite = definiteUtterances.length > 0;

        console.log('[ASR] msg.type=9, flag=', msg.flag, 'definiteCount=', definiteUtterances.length, 'allUtterances=', utterances.length, 'text=', text.substring(0, 30));

        if (!this.ready) {
          this.ready = true;
          this.sendEvent({ type: 'ready' });
          return;
        }

        // 对于 partial 显示，过滤掉上一轮已处理的文本前缀
        // ASR 服务端会累积所有 utterance，我们需要提取当前 turn 的新内容
        let displayText = text || '';

        // 去掉已处理文本的前缀（处理空格差异）
        if (this.lastProcessedText && displayText) {
          const normalizedProcessed = this.lastProcessedText.trim();
          const normalizedDisplay = displayText.trim();
          if (normalizedDisplay.startsWith(normalizedProcessed)) {
            displayText = normalizedDisplay.slice(normalizedProcessed.length).trim();
            // 去掉可能的前导标点
            displayText = displayText.replace(/^[，。！？,.!?\s]+/, '');
          }
        }

        console.log('[ASR] partial filter:', { original: text?.substring(0, 30), lastProcessed: this.lastProcessedText?.substring(0, 30), result: displayText?.substring(0, 30) });

        // 发送 partial 给前端显示（实时更新）
        if (displayText) {
          this.sendEvent({ type: 'partial', text: displayText, hasDefinite });
        }

        // 处理 definite=true 的utterance（二遍识别完成，最终结果）
        if (hasDefinite && !this.runningReply) {
          // 找到尚未处理的 definite utterance
          const newDefiniteUtterances = definiteUtterances.filter((u: any) => {
            const uid = u?.utterance_id || u?.start_time;
            if (!this.processedUtteranceIds.has(uid)) {
              this.processedUtteranceIds.add(uid);
              return true;
            }
            return false;
          });

          if (newDefiniteUtterances.length > 0) {
            const turnText = newDefiniteUtterances
              .map((u: any) => String(u?.text || '').trim())
              .filter(Boolean)
              .join(' ');

            if (turnText) {
              console.log('[ASR] definite utterance received:', turnText);
              this.currentTurnText += (this.currentTurnText ? ' ' : '') + turnText;
            }
          }

          // 触发 final（使用二遍识别的准确结果）
          if (this.currentTurnText) {
            console.log('[ASR] triggering final with definite text:', this.currentTurnText);
            this.runningReply = true;
            const finalText = this.currentTurnText;
            this.sendEvent({ type: 'final', text: finalText });

            // 记录已处理文本，用于下一轮过滤（使用ASR返回的原始格式）
            this.lastProcessedText = text;

            this.processReply(finalText).finally(() => {
              this.runningReply = false;
              this.currentTurnText = '';
            });
          }
        }
      } catch (e) {
        console.error('[ASR] parse error:', e);
      }
    });

    this.ws.on('close', () => {
      this.closed = true;
      this.sendEvent({ type: 'closed' });
    });

    this.ws.on('error', (err) => {
      this.sendEvent({ type: 'error', error: err.message });
    });
  }

  private async processReply(text: string) {
    try {
      await this.onFinal(text);
    } catch (err: any) {
      console.error('[TEST] onFinal error:', err);
      this.sendEvent({ type: 'error', error: String(err?.message || err) });
    }
  }

  feedPcmChunk(chunk: Buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready || this.closed || !chunk.length) return;
    for (let off = 0; off < chunk.length; off += 6400) {
      const piece = chunk.subarray(off, off + 6400);
      if (piece.length) this.ws.send(asrAudioOnly(this.nextSeq++, piece));
    }
  }

  finish() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.closed) return;
    this.ws.send(asrAudioOnlyLast(Buffer.alloc(0)));
  }

  close() {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ============ 前端页面 ============
const page = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>VoiceClaw 单工测试页</title>
<style>
body{font-family:system-ui;padding:24px;max-width:780px;margin:auto;background:#0b1020;color:#e8ecff}button{padding:12px 18px;border-radius:12px;border:none;background:#5b7cff;color:white;font-size:16px;cursor:pointer;margin-right:8px}button[disabled]{opacity:.5} .card{background:#121933;padding:16px;border-radius:16px;margin-top:16px} .mono{white-space:pre-wrap;font-family:ui-monospace,monospace} a{color:#9bb0ff}
</style></head><body>
<h1>VoiceClaw 单工 / 对讲机测试页</h1>
<p>当前模式：<b>单工</b>。先录音，再识别，再回复，再播语音。</p>
<p><a href="/phase1">进入：流式 ASR Phase 1 调试页</a></p>
<div>
<button id="startBtn">开始录音</button>
<button id="stopBtn" disabled>停止并发送</button>
</div>
<div class="card"><b>识别：</b><div id="asr" class="mono"></div></div>
<div class="card"><b>回复：</b><div id="reply" class="mono"></div></div>
<audio id="player" controls style="width:100%;margin-top:16px"></audio>
<script>
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const asr = document.getElementById('asr');
const reply = document.getElementById('reply');
const player = document.getElementById('player');
let mediaRecorder, stream, chunks=[];
async function startRec(){
  stream = await navigator.mediaDevices.getUserMedia({audio:true});
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  mediaRecorder = new MediaRecorder(stream, {mimeType});
  chunks=[];
  mediaRecorder.ondataavailable = e => { if(e.data && e.data.size) chunks.push(e.data); };
  mediaRecorder.onstop = async ()=>{
    startBtn.disabled=false; stopBtn.disabled=true;
    const blob = new Blob(chunks,{type:mimeType});
    const fd = new FormData(); fd.append('audio', blob, 'recording.webm');
    asr.textContent='识别中...'; reply.textContent='';
    const res = await fetch('/api/talk',{method:'POST',body:fd});
    const data = await res.json();
    asr.textContent = data.asr || '(空)';
    reply.textContent = data.reply || '(空)';
    if (data.audioBase64) {
      player.src = 'data:audio/mpeg;base64,' + data.audioBase64;
      player.play().catch(()=>{});
    }
    stream.getTracks().forEach(t=>t.stop());
  };
  mediaRecorder.start(250);
  startBtn.disabled=true; stopBtn.disabled=false;
};
function stopRec(){ if(mediaRecorder && mediaRecorder.state!=='inactive') mediaRecorder.stop(); }
startBtn.addEventListener('click', startRec);
stopBtn.addEventListener('click', stopRec);
</script></body></html>`;

const phase1Page = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>VoiceClaw 流式 ASR Phase 1</title>
<style>
body{font-family:system-ui;padding:24px;max-width:920px;margin:auto;background:#0b1020;color:#e8ecff}button{padding:12px 18px;border-radius:12px;border:none;background:#5b7cff;color:white;font-size:16px;cursor:pointer;margin-right:8px}button[disabled]{opacity:.5}.card{background:#121933;padding:16px;border-radius:16px;margin-top:16px}.mono{white-space:pre-wrap;font-family:ui-monospace,monospace} .state{display:inline-block;padding:6px 10px;border-radius:999px;background:#1f2a57;margin-left:8px} a{color:#9bb0ff}.hint{opacity:.8;font-size:14px;margin-top:10px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.metric{font-family:ui-monospace,monospace;font-size:13px}
</style></head><body>
<h1>VoiceClaw 流式 ASR Phase 1 调试页</h1>
<p>这版先打通：<b>浏览器持续采集</b> + <b>服务端 ASR 长连接 session</b>。</p>
<p>当前录音格式改成 <b>PCM/16k mono</b>，重点看 turn 切分和各阶段耗时。</p>
<p><a href="/">返回单工测试页</a></p>
<div>
<button id="startBtn">开始流式采集</button>
<button id="stopBtn" disabled>结束本轮</button>
<span class="state" id="state">idle</span>
</div>
<div class="hint">状态：idle → connecting → streaming → thinking → speaking。已加入前端 console 日志和时间戳统计。</div>
<div class="grid">
  <div class="card"><b>实时 partial：</b><div id="partial" class="mono"></div></div>
  <div class="card"><b>final ASR：</b><div id="asr" class="mono"></div></div>
</div>
<div class="card"><b>回复（流式）：</b><div id="reply" class="mono"></div></div>
<div class="card"><b>阶段耗时：</b><div id="metrics" class="metric"></div></div>
<audio id="player" controls style="width:100%;margin-top:16px"></audio>
<script>
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const partialEl = document.getElementById('partial');
const asrEl = document.getElementById('asr');
const replyEl = document.getElementById('reply');
const metricsEl = document.getElementById('metrics');
const player = document.getElementById('player');
const stateEl = document.getElementById('state');
let stream, ws, audioCtx, source, processor;
let turnStats = {};
let turnIndex = 0;
// MediaSource 用于流式音频播放
let mediaSource, sourceBuffer;
let audioQueue = [];
let isAppending = false;
let useMediaSource = false;
let accumulatedAudio = ''; // 用于累积 base64 音频

function now(){ return performance.now(); }
function ts(){ return new Date().toLocaleTimeString('zh-CN', { hour12:false }) + '.' + String(Date.now()%1000).padStart(3,'0'); }
function log(...args){ console.log('[voiceclaw phase1]', ts(), ...args); }
function setState(s){ stateEl.textContent = s; log('state=', s); }
function nextTurn(){ turnIndex += 1; turnStats = { turnIndex }; renderMetrics(); partialEl.textContent=''; asrEl.textContent=''; replyEl.textContent=''; accumulatedAudio=''; }
function setMark(name){ turnStats[name] = now(); renderMetrics(); }
function delta(a,b){ if(turnStats[a] == null || turnStats[b] == null) return '-'; return (turnStats[b]-turnStats[a]).toFixed(1) + 'ms'; }
function renderMetrics(){
  metricsEl.textContent = [
    'turn: ' + (turnStats.turnIndex || 0),
    'asrMs: ' + delta('capture_start','final_asr'),
    'llmMs: ' + (turnStats.llmMs != null ? turnStats.llmMs.toFixed(1) + 'ms' : '-'),
    'ttsMs: ' + (turnStats.ttsMs != null ? turnStats.ttsMs.toFixed(1) + 'ms' : '-'),
    'e2eMs: ' + delta('final_asr','audio_play'),
  ].join('\\n');
}
function resetTurnStats(){ turnStats = {}; renderMetrics(); }
function floatTo16BitPCM(float32Array){
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

// MediaSource 流式音频播放
function initMediaSource() {
  useMediaSource = false;
  accumulatedAudio = '';
  // 暂时不使用 MediaSource，直接用 base64 播放更可靠
  log('Using base64 audio playback (MediaSource disabled for reliability)');
  return false;
}

function processAudioQueue() {
  if (isAppending || !sourceBuffer || audioQueue.length === 0) return;
  isAppending = true;
  const chunk = audioQueue.shift();
  try {
    sourceBuffer.appendBuffer(chunk);
  } catch (e) {
    log('appendBuffer error:', e);
    isAppending = false;
  }
}

function queueAudioChunk(base64Data) {
  // 累积 base64 音频
  accumulatedAudio += base64Data;
  log('Audio chunk received, total length:', accumulatedAudio.length);
}

function playAccumulatedAudio() {
  if (!accumulatedAudio) {
    log('No audio to play');
    return;
  }
  log('Playing accumulated audio, length:', accumulatedAudio.length);
  player.src = 'data:audio/mpeg;base64,' + accumulatedAudio;
  player.play().then(() => {
    log('Audio playback started');
  }).catch((err) => {
    log('Audio playback failed:', err);
  });
}

async function startStreaming(){
  nextTurn();
  setMark('capture_start');
  log('start streaming clicked');

  // 初始化音频系统
  initMediaSource();
  accumulatedAudio = '';
  player.src = '';

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }
  });
  log('getUserMedia ok');
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/phase1');
  ws.binaryType = 'arraybuffer';
  ws.onopen = async () => {
    setMark('ws_open');
    setState('connecting');
    log('ws open, sending start');
    ws.send(JSON.stringify({ type: 'start', codec: 'pcm16le', sampleRate: 16000 }));
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    source = audioCtx.createMediaStreamSource(stream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (!ws || ws.readyState !== 1) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = floatTo16BitPCM(input);
      ws.send(pcm);
    };
    source.connect(processor);
    processor.connect(audioCtx.destination);
    setState('streaming');
    startBtn.disabled = true;
    stopBtn.disabled = false;
  };
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    log('ws message=', msg.type, msg);
    if (msg.type === 'ready') setState('streaming');
    if (msg.type === 'partial') {
      partialEl.textContent = '[turn ' + turnIndex + '][' + ts() + '] ' + (msg.text || '');
    }
    if (msg.type === 'final') {
      const finishedTurn = turnIndex;
      setMark('final_asr');
      asrEl.textContent = '[turn ' + finishedTurn + '][' + ts() + '] ' + (msg.text || '');
      partialEl.textContent = '';
      setState('thinking');
    }
    if (msg.type === 'reply_text') {
      if (!turnStats.reply_start) setMark('reply_start');
      replyEl.textContent += msg.text || '';
    }
    if (msg.type === 'audio_chunk') {
      // 累积音频块
      if (!turnStats.first_audio) {
        setMark('first_audio');
        setState('speaking');
      }
      if (msg.audioChunk) {
        queueAudioChunk(msg.audioChunk);
      }
    }
    if (msg.type === 'reply_done') {
      setMark('reply_recv');
      if (msg.metrics) {
        if (typeof msg.metrics.llmMs === 'number') turnStats.llmMs = msg.metrics.llmMs;
        if (typeof msg.metrics.ttsMs === 'number') turnStats.ttsMs = msg.metrics.ttsMs;
      }
      renderMetrics();
      // 播放累积的音频
      playAccumulatedAudio();
      nextTurn();
    }
    if (msg.type === 'error') {
      replyEl.textContent = '[' + ts() + '] 错误：' + msg.error;
      setState('idle');
    }
  };
  ws.onclose = () => { log('ws close'); setState('idle'); };
}
function stopStreaming(){
  log('stop streaming clicked');
  if (processor) processor.disconnect();
  if (source) source.disconnect();
  if (audioCtx) audioCtx.close();
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'stop' }));
  if (stream) stream.getTracks().forEach(t => t.stop());
  startBtn.disabled = false;
  stopBtn.disabled = true;
}
player.addEventListener('ended', () => { log('audio ended'); setState('idle'); });
startBtn.addEventListener('click', startStreaming);
stopBtn.addEventListener('click', stopStreaming);
renderMetrics();
</script></body></html>`;

// ============ HTTP 服务器 ============
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
    return;
  }
  if (req.method === 'GET' && req.url === '/phase1') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(phase1Page);
    return;
  }
  res.writeHead(404); res.end('not found');
});

// ============ WebSocket 服务器 ============
const wss = new WebSocketServer({ server, path: '/ws/phase1' });

wss.on('connection', (client) => {
  let asrSession: StreamingAsrSession | null = null;
  let stopped = false;

  const send = (data: unknown) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  };

  client.on('message', async (raw, isBinary) => {
    if (!isBinary) {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'start') {
        stopped = false;
        asrSession = new StreamingAsrSession(send, async (text) => {
          if (stopped) return;
          const asrDoneAt = Date.now();
          console.log('[TEST] final_received=', JSON.stringify({ text, at: asrDoneAt }));

          const llmStartAt = Date.now();
          let firstTtsAt: number | null = null;
          const ttsTimings: number[] = [];
          let fullReply = '';

          // 并行追踪 TTS 任务
          const pendingTts: Promise<void>[] = [];

          try {
            console.log('[TEST] calling streamChatWithKimi...');
            fullReply = await streamChatWithKimi(
              text,
              // onToken: 流式显示
              (token) => {
                console.log('[TEST] onToken:', JSON.stringify(token));
                send({ type: 'reply_text', text: token });
              },
              // onSentence: 句子缓冲触发 TTS
              (sentence) => {
                console.log('[TEST] sentence_ready=', JSON.stringify(sentence));
                const ttsStartAt = Date.now();
                const ttsPromise = streamTTS(
                  sentence,
                  // onAudioChunk: 流式推音频
                  (chunk) => {
                    if (!firstTtsAt) {
                      firstTtsAt = Date.now();
                      console.log('[TEST] first_audio_chunk_latency=', firstTtsAt - llmStartAt);
                    }
                    console.log('[TEST] audio_chunk size:', chunk.length);
                    send({ type: 'audio_chunk', audioChunk: chunk.toString('base64') });
                  }
                ).then(() => {
                  console.log('[TEST] TTS done for sentence:', sentence.substring(0, 20));
                  ttsTimings.push(Date.now() - ttsStartAt);
                }).catch((err) => {
                  console.error('[TEST] TTS error for sentence:', sentence.substring(0, 20), err);
                });
                pendingTts.push(ttsPromise);
              }
            );
            console.log('[TEST] streamChatWithKimi returned, fullReply length:', fullReply.length);

            // 等待所有 TTS 完成
            console.log('[TEST] waiting for', pendingTts.length, 'TTS tasks...');
            await Promise.all(pendingTts);
            console.log('[TEST] all TTS tasks done');

            const llmDoneAt = Date.now();
            const totalTtsMs = ttsTimings.reduce((a, b) => a + b, 0);

            console.log('[TEST] all_done=', JSON.stringify({
              text,
              replyText: fullReply,
              llmMs: llmDoneAt - llmStartAt,
              ttsMs: totalTtsMs,
              firstAudioLatency: firstTtsAt ? firstTtsAt - llmStartAt : null,
              e2eMs: llmDoneAt - asrDoneAt,
            }));

            // 保存到历史记录
            addToHistory(text, fullReply);
            console.log('[TEST] history saved, rounds=', (chatHistory.length - 1) / 2);

            send({
              type: 'reply_done',
              text: fullReply,
              metrics: {
                llmMs: llmDoneAt - llmStartAt,
                ttsMs: totalTtsMs,
                firstAudioLatency: firstTtsAt ? firstTtsAt - llmStartAt : null,
              }
            });

          } catch (e: any) {
            console.error('[TEST] error:', e);
            send({ type: 'error', error: e.message || String(e) });
          }
        });
        asrSession.start();
      }
      if (msg.type === 'stop') {
        stopped = true;
        asrSession?.finish();
      }
      return;
    }

    if (!stopped) {
      asrSession?.feedPcmChunk(Buffer.from(raw as Buffer));
    }
  });

  client.on('close', () => {
    stopped = true;
    asrSession?.close();
  });
});

const port = Number(process.env.VOICECLAW_TEST_PORT || 3017);
server.listen(port, () => {
  console.log(`VoiceClaw test page: http://127.0.0.1:${port}`);
});