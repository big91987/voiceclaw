import http from 'http';
import fs from 'fs';
import os from 'os';
import { gzipSync, gunzipSync } from 'zlib';
import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import { config } from './config';

function json(res: http.ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ============ Session 持久化 ============
interface SessionRecord {
  id: string;
  sessionKey: string;
  agentId: string;
  createdAt: number;
  lastUsedAt: number;
  turnCount: number;
}
interface SessionFile {
  lastSessionId: string | null;
  sessions: SessionRecord[];
}

const SESSION_FILE = `${os.homedir()}/.openclaw/voiceclaw-sessions.json`;

function loadSessionFile(): SessionFile {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return { lastSessionId: null, sessions: [] };
  }
}

function saveSessionFile(data: SessionFile) {
  try {
    fs.mkdirSync(`${os.homedir()}/.openclaw`, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[Session] save failed:', e);
  }
}

function createSession(agentId: string): SessionRecord {
  const rec: SessionRecord = {
    id: uuidv4(),
    sessionKey: `agent:${agentId}:web-sticky-${uuidv4()}`,
    agentId,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    turnCount: 0,
  };
  const data = loadSessionFile();
  data.sessions.push(rec);
  data.lastSessionId = rec.id;
  saveSessionFile(data);
  return rec;
}

function touchSession(sessionKey: string) {
  const data = loadSessionFile();
  const rec = data.sessions.find(s => s.sessionKey === sessionKey);
  if (rec) {
    rec.lastUsedAt = Date.now();
    rec.turnCount += 1;
    data.lastSessionId = rec.id;
    saveSessionFile(data);
  }
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
  private minLength = 8;   // 1.9.3: 增加最小长度，累积更多再触发
  private maxLength = 60;  // 1.9.3: 增加最大长度
  private flushTimeout = 200;  // 1.9.3: 增加超时，等待更多内容
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

    // 检查是否有标点，不管长度立即触发
    const anyPunct = /[。！？.!?，,；;]/;
    const match = this.buffer.match(new RegExp(`^[\\s\\S]+?[${anyPunct.source}]`));
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


async function streamChatWithOpenClaw(
  text: string,
  opts: { gatewayUrl: string; gatewayToken?: string; model?: string; tag?: string },
  onToken: (token: string) => void,
  onSentence: (sentence: string) => void
): Promise<string> {
  const sentenceBuffer = new SentenceBuffer(onSentence);
  const gatewayBase = (opts.gatewayUrl || 'http://127.0.0.1:18789').replace(/\/$/, '');
  const model = opts.model || 'openai-codex/gpt-5.3-codex';

  const body: any = {
    model,
    stream: true,
    messages: [
      {
        role: 'user',
        content: opts.tag ? `[tag:${opts.tag}] ${text}` : text,
      },
    ],
    metadata: opts.tag ? { tag: opts.tag } : undefined,
  };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (opts.gatewayToken) headers.authorization = `Bearer ${opts.gatewayToken}`;

  const response = await fetch(`${gatewayBase}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gateway HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }

  const bodyStream = response.body as unknown as NodeJS.ReadableStream;
  const decoder = new TextDecoder();
  let buffer = '';
  let fullReply = '';

  return new Promise((resolve, reject) => {
    bodyStream.on('data', (chunk: Buffer) => {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const content = parsed?.choices?.[0]?.delta?.content;
          if (content) {
            fullReply += content;
            onToken(content);
            sentenceBuffer.push(content);
          }
        } catch {
          // ignore parse failures for non-data lines
        }
      }
    });
    bodyStream.on('end', () => {
      sentenceBuffer.flush();
      resolve(fullReply);
    });
    bodyStream.on('error', reject);
  });
}

async function streamChatViaTestServer(
  text: string,
  opts: { proxyBase?: string; agentId?: string; sessionKey?: string; queueMode?: string },
  onToken: (token: string) => void,
  onSentence: (sentence: string) => void,
  onMetric?: (metric: { metric: string; at?: number; ms?: number }) => void,
  onTool?: (toolData: { name: string; phase: string; args?: unknown; result?: unknown }) => void
): Promise<string> {
  const sentenceBuffer = new SentenceBuffer(onSentence);
  const proxyBase = (opts.proxyBase || 'http://127.0.0.1:3456').replace(/\/$/, '');
  const agentId = opts.agentId || 'voice';

  const response = await fetch(`${proxyBase}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: text, agentId, sessionKey: opts.sessionKey || '', reuseSession: !!opts.sessionKey, queueMode: opts.queueMode || 'interrupt' }),
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Proxy HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }

  const bodyStream = response.body as unknown as NodeJS.ReadableStream;
  const decoder = new TextDecoder();
  let buffer = '';
  let fullReply = '';
  let gotFirstToken = false;
  let firstTokenTimer: NodeJS.Timeout | null = null;
  let renderedReply = '';

  const emitDelta = (delta: string) => {
    if (!delta) return;
    if (!gotFirstToken) {
      gotFirstToken = true;
      if (firstTokenTimer) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = null;
      }
    }
    fullReply += delta;
    onToken(delta);
    sentenceBuffer.push(delta);
  };

  const applyFullText = (nextText: string) => {
    if (!nextText) return;
    if (nextText === renderedReply) return;
    if (nextText.startsWith(renderedReply)) {
      const delta = nextText.slice(renderedReply.length);
      renderedReply = nextText;
      emitDelta(delta);
      return;
    }
    if (renderedReply.startsWith(nextText)) {
      return;
    }
    renderedReply = nextText;
    emitDelta(nextText);
  };

  const extractAssistantText = (parsed: any): string => {
    if (!parsed?.payload || typeof parsed.payload !== 'object') return '';
    const payload = parsed.payload;

    if (payload?.stream === 'assistant') {
      const data = payload?.data || {};
      if (typeof data.text === 'string' && data.text) return data.text;
      if (typeof data.delta === 'string' && data.delta) {
        return renderedReply + data.delta;
      }
      return '';
    }

    if (parsed?.event === 'chat' && payload?.message?.role === 'assistant') {
      // chat event 只用于结束检测，不重复提取文本
      return '';
    }

    return '';
  };

  return new Promise((resolve, reject) => {
    firstTokenTimer = setTimeout(() => {
      reject(new Error('Proxy stream timeout: no first token'));
    }, 10000);

    bodyStream.on('data', (chunk: Buffer) => {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        if (data === '[TIMEOUT]') {
          reject(new Error('Proxy timeout'));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed?.type === 'metric' && typeof parsed?.metric === 'string') {
            onMetric?.({ metric: parsed.metric, at: parsed.at, ms: parsed.ms });
            continue;
          }
          // Reset activity timer on any meaningful event (tool calls, lifecycle, etc.)
          if (!gotFirstToken && firstTokenTimer) {
            clearTimeout(firstTokenTimer);
            firstTokenTimer = setTimeout(() => {
              reject(new Error('Proxy stream timeout: no activity'));
            }, 15000);
          }
          // Forward tool events
          if (parsed?.event === 'agent' && parsed?.payload?.stream === 'tool') {
            const d = parsed.payload.data || {};
            onTool?.({ name: d.name || 'tool', phase: d.phase || '', args: d.args, result: d.result ?? d.partialResult });
            continue;
          }
          const assistantText = extractAssistantText(parsed);
          applyFullText(assistantText);
        } catch {
          // ignore parse failures for non-data lines
        }
      }
    });
    bodyStream.on('end', () => {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      sentenceBuffer.flush();
      resolve(fullReply);
    });
    bodyStream.on('error', (err) => {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      reject(err);
    });
  });
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
  private closingHandled = false;

  constructor() {
    this.sessionId = uuidv4();
    this.connect();
  }

  private connect() {
    this.closingHandled = false;
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
      this.failCurrentJob(err as Error);
    });

    this.ws.on('close', () => {
      console.log('[TTS_CONN] WebSocket closed, reconnecting...');
      this.ready = false;
      this.failCurrentJob(new Error('TTS socket closed'));
      setTimeout(() => this.connect(), 1000);
    });
  }

  private failCurrentJob(err: Error) {
    if (this.closingHandled) return;
    this.closingHandled = true;
    const job = this.currentJob;
    this.currentJob = null;
    if (job) {
      job.onError(err);
    }
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
      let settled = false;
      const onDone = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        // 清掉卡住的 currentJob，否则队列永远堵塞
        const idx = this.pendingQueue.findIndex(j => j.onDone === onDone);
        if (idx >= 0) {
          this.pendingQueue.splice(idx, 1);
        } else if (this.currentJob?.onDone === onDone) {
          this.currentJob = null;
          this.processQueue();
        }
        reject(new Error('TTS timeout'));
      }, 30000);

      this.pendingQueue.push({ text, onChunk, onDone, onError });
      this.processQueue();
    });
  }

  close() {
    this.ws?.close();
  }
}

// 全局 TTS 连接（懒初始化，避免空闲时不断重连）
let globalTtsConn: TtsConnection | null = null;

async function streamTTS(
  text: string,
  onAudioChunk: (chunk: Buffer) => void
): Promise<void> {
  console.log('[TEST] streamTTS:', text.substring(0, 30));
  if (!globalTtsConn) {
    globalTtsConn = new TtsConnection();
  }
  return globalTtsConn.synthesize(text, onAudioChunk);
}

// ============ 流式 ASR Session ============
class StreamingAsrSession {
  private ws: WebSocket | null = null;
  private nextSeq = 2;
  private ready = false;
  private closed = false;
  private reconnectScheduled = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectAttempts = 0;
  private readonly maxConnectAttempts = 6;
  private runningReply = false;
  private replyVersion = 0;  // 防止 stale .finally() 覆盖 barge-in 后的状态
  private processedUtteranceIds = new Set<string>();
  private currentTurnText = '';
  private lastProcessedText = ''; // 跟踪上一轮处理过的文本，用于过滤累积
  private lastUtteranceCount = 0; // 用于检测新语音（打断）
  private bargeInSent = false; // 本轮是否已发送打断

  constructor(
    private sendEvent: (data: unknown) => void,
    private onFinal: (text: string) => Promise<void>,
    private onBargeIn?: () => void, // 打断回调
  ) {}

  start() {
    this.closed = false;
    this.ready = false;
    this.nextSeq = 2;
    this.connectAttempts = 0;
    this.openSocket();
  }

  private openSocket() {
    if (this.closed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectScheduled = false;

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
      this.connectAttempts = 0;
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
          // 1.9.2: 不再 return，继续处理首条消息，避免首句丢失
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

        // 打断检测：仅在启用 onBargeIn 时生效，避免默认场景误打断
        if (this.onBargeIn && utterances.length > this.lastUtteranceCount && this.runningReply && !this.bargeInSent) {
          console.log('[ASR] barge-in detected, new utterances:', utterances.length - this.lastUtteranceCount);
          this.bargeInSent = true;
          this.runningReply = false;   // 立即释放，允许新发话触发 final
          this.currentTurnText = '';
          this.replyVersion++;         // 使旧 .finally() 失效
          this.sendEvent({ type: 'barge_in' });
          this.onBargeIn?.();
        }
        this.lastUtteranceCount = utterances.length;

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
            const myVersion = ++this.replyVersion;
            const finalText = this.currentTurnText;
            this.sendEvent({ type: 'final', text: finalText });

            // 记录已处理文本，用于下一轮过滤（使用ASR返回的原始格式）
            this.lastProcessedText = text;

            this.processReply(finalText).finally(() => {
              if (this.replyVersion !== myVersion) return; // barge-in 已重置，不覆盖
              this.runningReply = false;
              this.currentTurnText = '';
              this.bargeInSent = false;
            });
          }
        }
      } catch (e) {
        console.error('[ASR] parse error:', e);
      }
    });

    this.ws.on('close', () => {
      if (!this.closed && !this.ready) {
        this.scheduleReconnect('ASR ws closed before ready');
        return;
      }
      this.sendEvent({ type: 'closed' });
    });

    this.ws.on('error', (err) => {
      const message = err?.message || String(err);
      if (!this.closed && !this.ready) {
        this.scheduleReconnect(`ASR ws error: ${message}`);
        return;
      }
      this.sendEvent({ type: 'error', error: message });
    });
  }

  private scheduleReconnect(reason: string) {
    if (this.closed || this.reconnectScheduled) return;
    this.connectAttempts += 1;
    if (this.connectAttempts >= this.maxConnectAttempts) {
      this.sendEvent({ type: 'error', error: `${reason} (retry exhausted)` });
      return;
    }
    this.reconnectScheduled = true;
    const delayMs = Math.min(800 * this.connectAttempts, 3000);
    console.log(`[ASR] reconnect in ${delayMs}ms, attempt=${this.connectAttempts}, reason=${reason}`);
    this.reconnectTimer = setTimeout(() => this.openSocket(), delayMs);
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ============ 副语言 ASR Session（副语言特征全开 + 二遍识别）============
class ParaAsrSession {
  private ws: WebSocket | null = null;
  private nextSeq = 2;
  private ready = false;
  private closed = false;
  private runningReply = false;
  private replyVersion = 0;
  private processedIds = new Set<string | number>();
  private currentTurnText = '';
  private currentTurnAdditions: any = null;
  private lastProcessedText = '';
  private lastUtteranceCount = 0;
  private bargeInSent = false;

  constructor(
    private sendEvent: (data: unknown) => void,
    private onFinal: (text: string, additions: any) => Promise<void>,
    private onBargeIn?: () => void,
  ) {}

  start() {
    this.closed = false;
    this.ready = false;
    this.nextSeq = 2;
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
        audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
        request: {
          model_name: 'bigmodel',
          enable_itn: true,
          enable_punc: true,
          show_utterances: true,
          enable_nonstream: true,
          enable_emotion_detection: true,
          enable_gender_detection: true,
          show_speech_rate: true,
          show_volume: true,
          end_window_size: 800,
        },
      }));
    });

    this.ws.on('message', async (raw) => {
      const msg = parseAsr(Buffer.from(raw as Buffer));
      if (msg.type === 15) { this.sendEvent({ type: 'error', error: msg.payload }); return; }
      if (msg.type !== 9) return;
      try {
        const parsed = JSON.parse(msg.payload);
        const text = parsed?.result?.text || '';
        const utterances: any[] = parsed?.result?.utterances || [];
        const definiteUtterances = utterances.filter((u: any) => u?.definite === true);
        const hasDefinite = definiteUtterances.length > 0;

        if (!this.ready) { this.ready = true; this.sendEvent({ type: 'ready' }); }

        let displayText = text || '';
        if (this.lastProcessedText && displayText) {
          const norm = this.lastProcessedText.trim();
          const disp = displayText.trim();
          if (disp.startsWith(norm)) displayText = disp.slice(norm.length).trim().replace(/^[，。！？,.!?\s]+/, '');
        }
        if (displayText) this.sendEvent({ type: 'partial', text: displayText, hasDefinite });

        if (this.onBargeIn && utterances.length > this.lastUtteranceCount && this.runningReply && !this.bargeInSent) {
          this.bargeInSent = true;
          this.runningReply = false;
          this.currentTurnText = '';
          this.currentTurnAdditions = null;
          this.replyVersion++;
          this.sendEvent({ type: 'barge_in' });
          this.onBargeIn?.();
        }
        this.lastUtteranceCount = utterances.length;

        if (hasDefinite && !this.runningReply) {
          const newDef = definiteUtterances.filter((u: any) => {
            const uid = u?.utterance_id ?? u?.start_time;
            if (!this.processedIds.has(uid)) { this.processedIds.add(uid); return true; }
            return false;
          });
          if (newDef.length > 0) {
            const turnText = newDef.map((u: any) => String(u?.text || '').trim()).filter(Boolean).join(' ');
            if (turnText) {
              this.currentTurnText += (this.currentTurnText ? ' ' : '') + turnText;
              this.currentTurnAdditions = newDef[newDef.length - 1]?.additions || this.currentTurnAdditions;
            }
          }
          if (this.currentTurnText) {
            this.runningReply = true;
            const myVersion = ++this.replyVersion;
            const finalText = this.currentTurnText;
            const additions = this.currentTurnAdditions;
            this.sendEvent({ type: 'final', text: finalText, additions });
            if (additions) this.sendEvent({ type: 'para_features', additions });
            this.lastProcessedText = text;
            this.onFinal(finalText, additions).finally(() => {
              if (this.replyVersion !== myVersion) return;
              this.runningReply = false;
              this.currentTurnText = '';
              this.currentTurnAdditions = null;
              this.bargeInSent = false;
            });
          }
        }
      } catch (e) { console.error('[PARA_ASR] parse error:', e); }
    });

    this.ws.on('close', () => { this.sendEvent({ type: 'closed' }); });
    this.ws.on('error', (err) => { this.sendEvent({ type: 'error', error: (err as any)?.message || String(err) }); });
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
    if (this.ws) { this.ws.close(); this.ws = null; }
  }
}

const lobsterHalfDuplexPage = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>龙虾半双工语音对话</title>
<style>
body{font-family:system-ui;padding:24px;max-width:980px;margin:auto;background:#0a1226;color:#e8ecff}
button{padding:12px 18px;border-radius:12px;border:none;background:#4e8cff;color:white;font-size:16px;cursor:pointer}
button.off{background:#de4f5f}
button.sm{padding:7px 12px;font-size:13px;background:#2a3a6a}
input{padding:8px 10px;border-radius:8px;border:1px solid #2f3a63;background:#101a37;color:#e8ecff;width:100%;margin-top:6px}
input[type="checkbox"]{width:auto;margin-top:0}
select{padding:8px 10px;border-radius:8px;border:1px solid #2f3a63;background:#101a37;color:#e8ecff;width:100%;margin-top:6px;font-size:14px}
.card{background:#121f42;padding:14px;border-radius:14px;margin-top:14px}
.mono{white-space:pre-wrap;font-family:ui-monospace,monospace}
.state{display:inline-block;padding:6px 10px;border-radius:999px;background:#213160;margin-left:8px}
.ok{background:#1f6f43}.bad{background:#8f2b2b}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.hint{opacity:.86;font-size:14px}
.checkline{display:flex;align-items:center;gap:8px;margin-top:10px}
.session-row{display:flex;gap:8px;align-items:flex-end;margin-top:6px}
</style></head><body>
<h1>龙虾半双工语音对话</h1>
<p class="hint">链路：麦克风 -> 火山 ASR -> OpenClaw voice agent -> 火山 TTS。纯 proxy 模式，支持实时播放和打断。</p>
<div class="grid">
  <div><label>Proxy URL（根目录 test-server）</label><input id="proxyBase" value="http://127.0.0.1:3456"></div>
  <div><label>Agent ID</label><input id="agentId" value="voice"></div>
  <div class="checkline"><input id="enableBargeIn" type="checkbox"><label for="enableBargeIn">启用 Barge-in 打断</label></div>
  <div>
    <label>Session</label>
    <div class="session-row">
      <select id="sessionSelect" style="flex:1"></select>
      <button class="sm" id="newSessionBtn" type="button">+ 新建</button>
      <button class="sm" id="delSessionBtn" type="button" style="background:#5a2a2a">删除</button>
      <button class="sm" id="clearSessionBtn" type="button" style="background:#3a2a1a">清空</button>
    </div>
  </div>
</div>
<div style="margin-top:12px">
  <button id="toggleBtn">连接并开始对话</button>
  <span class="state" id="state">idle</span>
</div>
<div class="card"><b>ASR（实时）</b><div id="asrPartial" class="mono"></div></div>
<div class="card"><b>ASR（最终）</b><div id="asrFinal" class="mono"></div></div>
<div class="card"><b>助手回复</b><div id="reply" class="mono"></div></div>
<div class="card"><b>调试日志</b><div id="debug" class="mono"></div></div>
<script>
const btn = document.getElementById('toggleBtn');
const stateEl = document.getElementById('state');
const asrPartialEl = document.getElementById('asrPartial');
const asrFinalEl = document.getElementById('asrFinal');
const replyEl = document.getElementById('reply');
const debugEl = document.getElementById('debug');
const proxyBaseEl = document.getElementById('proxyBase');
const agentIdEl = document.getElementById('agentId');
const enableBargeInEl = document.getElementById('enableBargeIn');
const sessionSelect = document.getElementById('sessionSelect');
const newSessionBtn = document.getElementById('newSessionBtn');
const delSessionBtn = document.getElementById('delSessionBtn');
const clearSessionBtn = document.getElementById('clearSessionBtn');

let connected = false, stream, ws, micCtx, source, processor;
let playCtx = null, nextPlayTime = 0, decodeChain = Promise.resolve(), playerGeneration = 0;
let activeTurnId = 0;

function setState(s){ stateEl.textContent = s; }
function fmtMs(v){ return typeof v === 'number' ? v + 'ms' : '-'; }
function fmtTs(v){
  if (typeof v !== 'number') return '-';
  return new Date(v).toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(v % 1000).padStart(3, '0');
}
function dlog(msg){
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  debugEl.textContent = '[' + t + '] ' + msg + '\\n' + (debugEl.textContent || '');
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + '秒前';
  if (s < 3600) return Math.floor(s / 60) + '分钟前';
  if (s < 86400) return Math.floor(s / 3600) + '小时前';
  return Math.floor(s / 86400) + '天前';
}

async function loadSessions() {
  const agentId = agentIdEl.value || 'voice';
  try {
    const r = await fetch('/api/sessions?agentId=' + encodeURIComponent(agentId));
    const data = await r.json();
    const sessions = data.sessions || [];
    const lastId = data.lastSessionId;
    sessionSelect.innerHTML = '';
    if (sessions.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（无已保存 session）';
      sessionSelect.appendChild(opt);
    } else {
      sessions.slice().reverse().forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.sessionKey;
        opt.textContent = s.turnCount + '轮 · ' + timeAgo(s.lastUsedAt) + ' · ' + s.sessionKey.slice(-8);
        opt.dataset.id = s.id;
        sessionSelect.appendChild(opt);
      });
      if (lastId) {
        const lastSession = sessions.find(s => s.id === lastId);
        if (lastSession) sessionSelect.value = lastSession.sessionKey;
      }
    }
  } catch(e) {
    dlog('load sessions failed: ' + e);
  }
}

newSessionBtn.addEventListener('click', async () => {
  const agentId = agentIdEl.value || 'voice';
  try {
    const r = await fetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId }),
    });
    const rec = await r.json();
    await loadSessions();
    sessionSelect.value = rec.sessionKey;
    dlog('新建 session: ' + rec.sessionKey.slice(-8));
  } catch(e) {
    dlog('new session failed: ' + e);
  }
});

delSessionBtn.addEventListener('click', async () => {
  const key = sessionSelect.value;
  if (!key) return;
  await fetch('/api/sessions/' + encodeURIComponent(key), { method: 'DELETE' });
  dlog('删除 session: ' + key.slice(-8));
  await loadSessions();
});

clearSessionBtn.addEventListener('click', async () => {
  if (!confirm('清空所有已保存的 session？')) return;
  const agentId = agentIdEl.value || 'voice';
  await fetch('/api/sessions?agentId=' + encodeURIComponent(agentId), { method: 'DELETE' });
  dlog('清空所有 session');
  await loadSessions();
});

loadSessions();

function floatTo16BitPCM(float32Array){
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let v = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
  }
  return buffer;
}

function base64ToArrayBuffer(base64){
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function resetPlayer(){
  playerGeneration += 1;
  nextPlayTime = 0;
  decodeChain = Promise.resolve();
  if (playCtx) { playCtx.close().catch(() => {}); playCtx = null; }
  playCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function enqueueChunk(base64Data){
  if (!base64Data) return;
  const arr = base64ToArrayBuffer(base64Data);
  const gen = playerGeneration;
  decodeChain = decodeChain.then(async () => {
    if (!playCtx || gen !== playerGeneration) return;
    const audioBuf = await playCtx.decodeAudioData(arr.slice(0));
    if (gen !== playerGeneration) return;
    if (!nextPlayTime) nextPlayTime = playCtx.currentTime + 0.03;
    const src = playCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(playCtx.destination);
    src.start(nextPlayTime);
    nextPlayTime += Math.max(0.001, audioBuf.duration - 0.01);
  }).catch(() => {});
}

async function connectAndTalk(){
  if (connected) return;
  connected = true;
  btn.textContent = '断开连接';
  btn.classList.add('off');
  setState('connecting');
  asrPartialEl.textContent = '';
  asrFinalEl.textContent = '';
  replyEl.textContent = '';
  activeTurnId = 0;
  resetPlayer();

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    replyEl.textContent = '麦克风失败: ' + (e && e.message ? e.message : e);
    disconnect();
    return;
  }

  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/phase2-claw');
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    dlog('ws open');
    ws.send(JSON.stringify({
      type: 'start',
      codec: 'pcm16le',
      sampleRate: 16000,
      mode: 'openclaw',
      proxyBase: proxyBaseEl.value,
      agentId: agentIdEl.value,
      chatMode: 'proxy',
      enableBargeIn: !!enableBargeInEl.checked,
      sessionKey: sessionSelect.value || '',
    }));
    micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    source = micCtx.createMediaStreamSource(stream);
    processor = micCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (ws && ws.readyState === 1) ws.send(floatTo16BitPCM(e.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(micCtx.destination);
    setState('streaming');
  };

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (typeof msg.turnId === 'number') {
      if (msg.turnId < activeTurnId) return;
      if (msg.turnId > activeTurnId) {
        activeTurnId = msg.turnId;
        replyEl.textContent = '';
        resetPlayer();
      }
    }
    if (msg.type === 'partial') asrPartialEl.textContent = msg.text || '';
    if (msg.type === 'final') { asrFinalEl.textContent = msg.text || ''; setState('thinking'); }
    if (msg.type === 'reply_text') replyEl.textContent += msg.text || '';
    if (msg.type === 'audio_chunk' && msg.audioChunk) { enqueueChunk(msg.audioChunk); setState('speaking'); }
    if (msg.type === 'reply_done') {
      const m = msg.metrics || {};
      dlog(
        'reply done ' +
        '[turn=' + (msg.turnId || '-') + '] ' +
        'asr_final=' + fmtTs(m.asrFinalAt) + ' ' +
        'llm_start=' + fmtTs(m.llmStartAt) + ' ' +
        'first_token=' + fmtTs(m.firstTokenAt) + ' ' +
        'first_sentence=' + fmtTs(m.firstSentenceAt) + ' ' +
        'first_audio=' + fmtTs(m.firstAudioAt) + ' ' +
        'gw_first_delta=' + fmtTs(m.proxyGatewayFirstDeltaAt) + ' ' +
        'llm_ms=' + fmtMs(m.llmMs) + ' ' +
        'gw_first_delta_ms=' + fmtMs(m.proxyGatewayFirstDeltaMs) + ' ' +
        'asr_to_first_token=' + fmtMs(m.asrToFirstTokenMs) + ' ' +
        'asr_to_first_audio=' + fmtMs(m.asrToFirstAudioMs) + ' ' +
        'tts_ms=' + fmtMs(m.ttsMs)
      );
      setState('streaming');
      loadSessions();
    }
    if (msg.type === 'metric' && msg.metric === 'session_start') {
      dlog(
        'session start ' +
        'run=' + (msg.runId || '-') + ' ' +
        'session=' + (msg.sessionKey || '-') + ' ' +
        'reuse=' + (!!msg.reuseSession)
      );
    }
    if (msg.type === 'barge_in') {
      dlog('barge_in: stop current playback');
      activeTurnId += 1;
      resetPlayer();
      setState('streaming');
    }
    if (msg.type === 'error') {
      replyEl.textContent = '错误: ' + (msg.error || 'unknown');
      dlog('server error: ' + (msg.error || 'unknown'));
    }
  };

  ws.onerror = () => dlog('ws error');
  ws.onclose = () => { dlog('ws close'); if (connected) disconnect(); };
}

function disconnect(){
  if (!connected) return;
  connected = false;
  try { if (processor) processor.disconnect(); } catch {}
  try { if (source) source.disconnect(); } catch {}
  try { if (micCtx) micCtx.close(); } catch {}
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'stop' })); } catch {}
  try { if (ws) ws.close(); } catch {}
  try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch {}
  btn.textContent = '连接并开始对话';
  btn.classList.remove('off');
  setState('idle');
}

btn.addEventListener('click', () => {
  if (connected) disconnect();
  else connectAndTalk().catch((e) => { replyEl.textContent = '连接失败: ' + (e && e.message ? e.message : e); disconnect(); });
});
</script></body></html>`;

const paralinguisticPage = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>副语言特征分析</title>
<style>
body{font-family:system-ui;padding:24px;max-width:1100px;margin:auto;background:#0a1226;color:#e8ecff}
button{padding:12px 18px;border-radius:12px;border:none;background:#4e8cff;color:white;font-size:16px;cursor:pointer}
button.off{background:#de4f5f}
button.sm{padding:7px 12px;font-size:13px;background:#2a3a6a}
input{padding:8px 10px;border-radius:8px;border:1px solid #2f3a63;background:#101a37;color:#e8ecff;width:100%;margin-top:6px}
input[type="checkbox"]{width:auto;margin-top:0}
select{padding:8px 10px;border-radius:8px;border:1px solid #2f3a63;background:#101a37;color:#e8ecff;width:100%;margin-top:6px;font-size:14px}
.card{background:#121f42;padding:14px;border-radius:14px;margin-top:14px}
.mono{white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:13px}
.state{display:inline-block;padding:6px 10px;border-radius:999px;background:#213160;margin-left:8px}
.ok{background:#1f6f43}.bad{background:#8f2b2b}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.hint{opacity:.86;font-size:14px}
.checkline{display:flex;align-items:center;gap:8px;margin-top:10px}
.session-row{display:flex;gap:8px;align-items:flex-end;margin-top:6px}
/* 副语言面板 */
.para-dashboard{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:14px}
.feat-card{background:#121f42;border-radius:14px;padding:16px 12px;text-align:center;transition:background .4s}
.feat-title{font-size:12px;opacity:.6;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
.feat-emoji{font-size:40px;line-height:1.1;margin-bottom:4px}
.feat-label{font-size:16px;font-weight:600;margin-bottom:2px}
.feat-score{font-size:12px;opacity:.6}
.feat-value{font-size:36px;font-weight:700;line-height:1.1;margin-bottom:2px}
.feat-unit{font-size:12px;opacity:.6}
/* 历史 */
.hist-entry{padding:8px 10px;border-radius:8px;background:#0e1830;margin-top:6px;font-size:13px}
.hist-text{margin-bottom:4px;opacity:.9}
.hist-badges{display:flex;flex-wrap:wrap;gap:6px}
.badge{padding:2px 8px;border-radius:999px;font-size:11px;background:#213160}
</style></head><body>
<h1>副语言特征分析</h1>
<p class="hint">链路：麦克风 → 火山 ASR (副语言全开) → OpenClaw → TTS。副语言特征来自 bigmodel_async 二遍识别。</p>
<div class="grid2">
  <div><label>Proxy URL</label><input id="proxyBase" value="http://127.0.0.1:3456"></div>
  <div><label>Agent ID</label><input id="agentId" value="voice"></div>
  <div class="checkline"><input id="enableBargeIn" type="checkbox"><label for="enableBargeIn">Barge-in 打断</label></div>
  <div><label>Queue Mode</label><select id="queueMode"><option value="interrupt" selected>interrupt（打断当前）</option><option value="collect">collect（排队等待）</option><option value="steer">steer（注入当前）</option></select></div>
  <div class="checkline"><input id="injectPara" type="checkbox" checked><label for="injectPara">将副语言注入到 Agent 输入</label></div>
  <div>
    <label>Session</label>
    <div class="session-row">
      <select id="sessionSelect" style="flex:1"></select>
      <button class="sm" id="newSessionBtn" type="button">+ 新建</button>
      <button class="sm" id="delSessionBtn" type="button" style="background:#5a2a2a">删除</button>
      <button class="sm" id="clearSessionBtn" type="button" style="background:#3a2a1a">清空</button>
    </div>
  </div>
</div>
<div style="margin-top:12px">
  <button id="toggleBtn">连接并开始</button>
  <span class="state" id="state">idle</span>
</div>

<div class="para-dashboard">
  <div class="feat-card" id="cardEmotion">
    <div class="feat-title">情绪</div>
    <div class="feat-emoji" id="emotionEmoji">❓</div>
    <div class="feat-label" id="emotionLabel">—</div>
    <div class="feat-score" id="emotionScore"></div>
  </div>
  <div class="feat-card" id="cardGender">
    <div class="feat-title">性别</div>
    <div class="feat-emoji" id="genderEmoji">❓</div>
    <div class="feat-label" id="genderLabel">—</div>
    <div class="feat-score" id="genderScore"></div>
  </div>
  <div class="feat-card">
    <div class="feat-title">语速</div>
    <div class="feat-value" id="speechRateEl">—</div>
    <div class="feat-unit">tokens/s</div>
  </div>
  <div class="feat-card">
    <div class="feat-title">音量</div>
    <div class="feat-value" id="volumeEl">—</div>
    <div class="feat-unit">dB</div>
  </div>
</div>

<div class="card"><b>ASR（实时）</b><div id="asrPartial" class="mono"></div></div>
<div class="card" id="toolCard" style="display:none"><b>工具调用</b><div id="toolStatus" class="mono"></div></div>
<div class="card"><b>ASR（最终 + 副语言）</b><div id="asrFinal" class="mono"></div></div>
<div class="card"><b>助手回复</b><div id="reply" class="mono"></div></div>
<div class="card">
  <b>历史记录</b>
  <div id="historyList"></div>
</div>
<div class="card"><b>调试日志</b><div id="debug" class="mono"></div></div>

<script>
const btn = document.getElementById('toggleBtn');
const stateEl = document.getElementById('state');
const asrPartialEl = document.getElementById('asrPartial');
const asrFinalEl = document.getElementById('asrFinal');
const replyEl = document.getElementById('reply');
const debugEl = document.getElementById('debug');
const historyList = document.getElementById('historyList');
const proxyBaseEl = document.getElementById('proxyBase');
const agentIdEl = document.getElementById('agentId');
const enableBargeInEl = document.getElementById('enableBargeIn');
const injectParaEl = document.getElementById('injectPara');
const sessionSelect = document.getElementById('sessionSelect');
const newSessionBtn = document.getElementById('newSessionBtn');
const delSessionBtn = document.getElementById('delSessionBtn');
const clearSessionBtn = document.getElementById('clearSessionBtn');

let connected = false, stream, ws, micCtx, source, processor;
let playCtx = null, nextPlayTime = 0, decodeChain = Promise.resolve(), playerGeneration = 0;
let activeTurnId = 0;

const EMOTION_META = {
  angry:    { emoji: '😡', label: '愤怒', bg: '#5a1a1a' },
  happy:    { emoji: '😄', label: '开心', bg: '#1a4a2a' },
  neutral:  { emoji: '😐', label: '平静', bg: '#1e2a4a' },
  sad:      { emoji: '😢', label: '悲伤', bg: '#1a2a5a' },
  surprise: { emoji: '😲', label: '惊讶', bg: '#3a1a6a' },
};

function setState(s){ stateEl.textContent = s; }
function dlog(msg){
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  debugEl.textContent = '[' + t + '] ' + msg + '\\n' + (debugEl.textContent || '');
}
function fmtMs(v){ return typeof v === 'number' ? v + 'ms' : '-'; }
function timeAgo(ts){
  const s = Math.floor((Date.now()-ts)/1000);
  if(s<60) return s+'秒前';
  if(s<3600) return Math.floor(s/60)+'分钟前';
  return Math.floor(s/3600)+'小时前';
}

function updateParaDashboard(additions) {
  if (!additions) return;
  const emotion = additions.emotion || '';
  const emotionScore = parseFloat(additions.emotion_score || '0');
  const emotionDegree = additions.emotion_degree || '';
  const gender = additions.gender || '';
  const genderScore = parseFloat(additions.gender_score || '0');
  const speechRate = parseFloat(additions.speech_rate || '0');
  const volume = parseFloat(additions.volume || '0');

  const meta = EMOTION_META[emotion];
  document.getElementById('emotionEmoji').textContent = meta ? meta.emoji : '❓';
  document.getElementById('emotionLabel').textContent = meta ? meta.label : (emotion || '—');
  document.getElementById('emotionScore').textContent = emotionScore ? (emotionScore * 100).toFixed(0) + '%' + (emotionDegree ? ' · ' + emotionDegree : '') : '';
  document.getElementById('cardEmotion').style.background = meta ? meta.bg : '#121f42';

  const genderMeta = gender === 'female' ? { emoji: '♀', label: '女性' } : gender === 'male' ? { emoji: '♂', label: '男性' } : null;
  document.getElementById('genderEmoji').textContent = genderMeta ? genderMeta.emoji : '❓';
  document.getElementById('genderEmoji').style.fontSize = '36px';
  document.getElementById('genderLabel').textContent = genderMeta ? genderMeta.label : (gender || '—');
  document.getElementById('genderScore').textContent = genderScore ? (genderScore * 100).toFixed(0) + '%' : '';
  document.getElementById('cardGender').style.background = gender === 'female' ? '#3a1a4a' : gender === 'male' ? '#1a2a4a' : '#121f42';

  document.getElementById('speechRateEl').textContent = speechRate ? speechRate.toFixed(1) : '—';
  document.getElementById('volumeEl').textContent = volume ? volume.toFixed(1) : '—';
}

function addHistory(text, additions, role) {
  const entry = document.createElement('div');
  entry.className = 'hist-entry';
  if (role === 'assistant') entry.style.cssText = 'border-left: 3px solid #4a9eff; padding-left: 8px; opacity: 0.85';
  const textDiv = document.createElement('div');
  textDiv.className = 'hist-text';
  textDiv.textContent = (role === 'assistant' ? '🤖 ' : '👤 ') + text;
  entry.appendChild(textDiv);
  if (additions) {
    const badges = document.createElement('div');
    badges.className = 'hist-badges';
    const addBadge = (text, color) => {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = text;
      if (color) b.style.background = color;
      badges.appendChild(b);
    };
    if (additions.emotion) {
      const meta = EMOTION_META[additions.emotion];
      addBadge((meta ? meta.emoji + ' ' + meta.label : additions.emotion) + (additions.emotion_degree ? '·' + additions.emotion_degree : ''), meta ? meta.bg : null);
    }
    if (additions.gender) addBadge(additions.gender === 'female' ? '♀ 女性' : '♂ 男性', null);
    if (additions.speech_rate) addBadge('语速 ' + parseFloat(additions.speech_rate).toFixed(1) + ' t/s', null);
    if (additions.volume) addBadge('音量 ' + parseFloat(additions.volume).toFixed(0) + ' dB', null);
    entry.appendChild(badges);
  }
  historyList.insertBefore(entry, historyList.firstChild);
}

async function loadSessions() {
  const agentId = agentIdEl.value || 'voice';
  try {
    const r = await fetch('/api/sessions?agentId=' + encodeURIComponent(agentId));
    const data = await r.json();
    const sessions = data.sessions || [];
    const lastId = data.lastSessionId;
    sessionSelect.innerHTML = '';
    if (sessions.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（无已保存 session）';
      sessionSelect.appendChild(opt);
    } else {
      sessions.slice().reverse().forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.sessionKey;
        opt.textContent = s.turnCount + '轮 · ' + timeAgo(s.lastUsedAt) + ' · ' + s.sessionKey.slice(-8);
        opt.dataset.id = s.id;
        sessionSelect.appendChild(opt);
      });
      if (lastId) {
        const last = sessions.find(s => s.id === lastId);
        if (last) sessionSelect.value = last.sessionKey;
      }
    }
  } catch(e) { dlog('load sessions failed: ' + e); }
}

newSessionBtn.addEventListener('click', async () => {
  const agentId = agentIdEl.value || 'voice';
  try {
    const r = await fetch('/api/sessions/new', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ agentId }) });
    const rec = await r.json();
    await loadSessions();
    sessionSelect.value = rec.sessionKey;
    dlog('新建 session: ' + rec.sessionKey.slice(-8));
  } catch(e) { dlog('new session failed: ' + e); }
});
delSessionBtn.addEventListener('click', async () => {
  const key = sessionSelect.value;
  if (!key) return;
  await fetch('/api/sessions/' + encodeURIComponent(key), { method: 'DELETE' });
  dlog('删除 session');
  await loadSessions();
});
clearSessionBtn.addEventListener('click', async () => {
  if (!confirm('清空所有已保存的 session？')) return;
  const agentId = agentIdEl.value || 'voice';
  await fetch('/api/sessions?agentId=' + encodeURIComponent(agentId), { method: 'DELETE' });
  await loadSessions();
});
loadSessions();

function floatTo16BitPCM(float32Array){
  const buf = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32Array.length; i++) {
    let v = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i*2, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
  }
  return buf;
}
function base64ToArrayBuffer(b64){
  const bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function resetPlayer(){
  playerGeneration++;
  nextPlayTime = 0;
  decodeChain = Promise.resolve();
  if (playCtx) { playCtx.close().catch(()=>{}); playCtx = null; }
  playCtx = new (window.AudioContext || window.webkitAudioContext)();
}
function enqueueChunk(base64Data){
  if (!base64Data) return;
  const arr = base64ToArrayBuffer(base64Data);
  const gen = playerGeneration;
  decodeChain = decodeChain.then(async () => {
    if (!playCtx || gen !== playerGeneration) return;
    const audioBuf = await playCtx.decodeAudioData(arr.slice(0));
    if (gen !== playerGeneration) return;
    if (!nextPlayTime) nextPlayTime = playCtx.currentTime + 0.03;
    const src = playCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(playCtx.destination);
    src.start(nextPlayTime);
    nextPlayTime += Math.max(0.001, audioBuf.duration - 0.01);
  }).catch(()=>{});
}

async function connectAndTalk(){
  if (connected) return;
  connected = true;
  btn.textContent = '断开连接';
  btn.classList.add('off');
  setState('connecting');
  asrPartialEl.textContent = '';
  asrFinalEl.textContent = '';
  replyEl.textContent = '';
  activeTurnId = 0;
  resetPlayer();

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch(e) {
    replyEl.textContent = '麦克风失败: ' + (e && e.message ? e.message : e);
    disconnect();
    return;
  }

  ws = new WebSocket((location.protocol==='https:' ? 'wss://' : 'ws://') + location.host + '/ws/para-claw');
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    dlog('ws open');
    ws.send(JSON.stringify({
      type: 'start',
      codec: 'pcm16le',
      sampleRate: 16000,
      proxyBase: proxyBaseEl.value,
      agentId: agentIdEl.value,
      enableBargeIn: !!enableBargeInEl.checked,
      injectPara: !!injectParaEl.checked,
      sessionKey: sessionSelect.value || '',
      queueMode: document.getElementById('queueMode')?.value || 'interrupt',
    }));
    micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    source = micCtx.createMediaStreamSource(stream);
    processor = micCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (ws && ws.readyState === 1) ws.send(floatTo16BitPCM(e.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(micCtx.destination);
    setState('streaming');
  };

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (typeof msg.turnId === 'number') {
      if (msg.turnId < activeTurnId) return;
      if (msg.turnId > activeTurnId) {
        activeTurnId = msg.turnId;
        replyEl.textContent = '';
        resetPlayer();
        const toolCard = document.getElementById('toolCard');
        if (toolCard) toolCard.style.display = 'none';
      }
    }
    if (msg.type === 'partial') asrPartialEl.textContent = msg.text || '';
    if (msg.type === 'tool_event') {
      const toolCard = document.getElementById('toolCard');
      const toolStatus = document.getElementById('toolStatus');
      if (toolCard && toolStatus) {
        toolCard.style.display = '';
        if (msg.phase === 'start') {
          toolStatus.textContent = '▶ ' + msg.name + (msg.args ? '\\n' + JSON.stringify(msg.args, null, 2) : '');
          setState('tool:' + msg.name);
        } else if (msg.phase === 'result') {
          const out = msg.result ? JSON.stringify(msg.result, null, 2).slice(0, 300) : '';
          toolStatus.textContent = '✓ ' + msg.name + (out ? '\\n' + out : '');
        }
      }
    }
    if (msg.type === 'final') {
      const toolCard = document.getElementById('toolCard');
      if (toolCard) toolCard.style.display = 'none';
      let label = (msg.text || '');
      if (msg.additions) {
        const a = msg.additions;
        const parts = [];
        if (a.emotion) parts.push((EMOTION_META[a.emotion] ? EMOTION_META[a.emotion].label : a.emotion) + (a.emotion_degree ? '(' + a.emotion_degree + ')' : ''));
        if (a.gender) parts.push(a.gender === 'female' ? '♀' : '♂');
        if (a.speech_rate) parts.push(parseFloat(a.speech_rate).toFixed(1) + 't/s');
        if (a.volume) parts.push(parseFloat(a.volume).toFixed(0) + 'dB');
        if (parts.length) label += '  [' + parts.join(' · ') + ']';
      }
      asrPartialEl.textContent = '';
      asrFinalEl.textContent = label;
      setState('thinking');
    }
    if (msg.type === 'para_features') updateParaDashboard(msg.additions);
    if (msg.type === 'history_entry') addHistory(msg.text, msg.additions, msg.role);
    if (msg.type === 'reply_text') replyEl.textContent += msg.text || '';
    if (msg.type === 'audio_chunk' && msg.audioChunk) { enqueueChunk(msg.audioChunk); setState('speaking'); }
    if (msg.type === 'reply_done') {
      const m = msg.metrics || {};
      dlog('done [t=' + (msg.turnId||'-') + '] asr→token=' + fmtMs(m.asrToFirstTokenMs) + ' asr→audio=' + fmtMs(m.asrToFirstAudioMs));
      setState('streaming');
      loadSessions();
    }
    if (msg.type === 'barge_in') {
      dlog('barge_in');
      activeTurnId++;
      resetPlayer();
      setState('streaming');
    }
    if (msg.type === 'error') {
      replyEl.textContent = '错误: ' + (msg.error || 'unknown');
      dlog('error: ' + (msg.error || 'unknown'));
    }
  };

  ws.onerror = () => dlog('ws error');
  ws.onclose = () => { dlog('ws close'); if (connected) disconnect(); };
}

function disconnect(){
  if (!connected) return;
  connected = false;
  try { if (processor) processor.disconnect(); } catch {}
  try { if (source) source.disconnect(); } catch {}
  try { if (micCtx) micCtx.close(); } catch {}
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'stop' })); } catch {}
  try { if (ws) ws.close(); } catch {}
  try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch {}
  btn.textContent = '连接并开始';
  btn.classList.remove('off');
  setState('idle');
}

btn.addEventListener('click', () => {
  if (connected) disconnect();
  else connectAndTalk().catch((e) => { replyEl.textContent = '连接失败: ' + (e && e.message ? e.message : e); disconnect(); });
});
</script></body></html>`;

// ============ HTTP 服务器 ============
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/lobster' || req.url === '/lobster-half' || req.url === '/phase2-lobster')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(lobsterHalfDuplexPage);
    return;
  }
  if (req.method === 'GET' && req.url === '/para') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(paralinguisticPage);
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/api/sessions')) {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const agentId = urlObj.searchParams.get('agentId') || 'voice';
    const data = loadSessionFile();
    const sessions = data.sessions.filter(s => s.agentId === agentId);
    json(res, 200, { sessions, lastSessionId: data.lastSessionId });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/sessions/new') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { agentId = 'voice' } = JSON.parse(body || '{}');
      const rec = createSession(agentId);
      json(res, 200, rec);
    });
    return;
  }
  if (req.method === 'DELETE' && req.url?.startsWith('/api/sessions/')) {
    const sessionKey = decodeURIComponent(req.url.slice('/api/sessions/'.length));
    const data = loadSessionFile();
    data.sessions = data.sessions.filter(s => s.sessionKey !== sessionKey);
    if (data.lastSessionId && !data.sessions.find(s => s.id === data.lastSessionId)) {
      data.lastSessionId = data.sessions[data.sessions.length - 1]?.id || null;
    }
    saveSessionFile(data);
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === 'DELETE' && req.url === '/api/sessions') {
    const data = loadSessionFile();
    const agentId = new URL(req.url, 'http://x').searchParams.get('agentId');
    data.sessions = agentId ? data.sessions.filter(s => s.agentId !== agentId) : [];
    data.lastSessionId = data.sessions[data.sessions.length - 1]?.id || null;
    saveSessionFile(data);
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/api/gateway-heartbeat')) {
    try {
      const urlObj = new URL(req.url, 'http://127.0.0.1');
      const gatewayUrl = (urlObj.searchParams.get('gatewayUrl') || 'http://127.0.0.1:18789').replace(/\/$/, '');
      const gatewayToken = urlObj.searchParams.get('gatewayToken') || '';
      const headers: Record<string, string> = {};
      if (gatewayToken) headers.authorization = `Bearer ${gatewayToken}`;
      const r = await fetch(`${gatewayUrl}/`, { method: 'GET', headers });
      json(res, 200, { ok: r.ok, status: r.status });
    } catch (e: any) {
      json(res, 200, { ok: false, error: String(e?.message || e) });
    }
    return;
  }
  res.writeHead(404); res.end('not found');
});

const wssPhase2 = new WebSocketServer({ noServer: true });

const wssParaClaw = new WebSocketServer({ noServer: true });

wssParaClaw.on('connection', (client, req) => {
  console.log('[PARA] ws connected from', req.socket.remoteAddress);
  let asrSession: ParaAsrSession | null = null;
  let stopped = false;
  let turnCounter = 0;
  let generation = 0;
  let gw = {
    proxyBase: 'http://127.0.0.1:3456',
    agentId: 'voice',
    enableBargeIn: false,
    injectPara: true,
    sessionKey: '',
    queueMode: 'interrupt',
  };

  const send = (data: unknown) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  };

  client.on('message', async (raw, isBinary) => {
    if (!isBinary) {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'start') {
        stopped = false;
        turnCounter = 0;
        gw = {
          proxyBase: msg.proxyBase || gw.proxyBase,
          agentId: msg.agentId || gw.agentId,
          enableBargeIn: !!msg.enableBargeIn,
          injectPara: msg.injectPara !== false,
          sessionKey: msg.sessionKey || '',
          queueMode: msg.queueMode || 'interrupt',
        };

        asrSession = new ParaAsrSession(
          send,
          async (text: string, additions: any) => {
            if (stopped) return;
            const turnId = ++turnCounter;
            const myGeneration = ++generation;
            const asrFinalAt = Date.now();
            let firstTokenAt: number | null = null;
            let firstSentenceAt: number | null = null;
            let firstTtsAt: number | null = null;
            const pendingTts: Promise<void>[] = [];
            let proxyGatewayFirstDeltaAt: number | null = null;
            let proxyGatewayFirstDeltaMs: number | null = null;

            // Notify frontend of history entry with features
            send({ type: 'history_entry', text, additions });

            // Build agent input (optionally inject paralinguistic context)
            let agentText = text;
            if (gw.injectPara && additions) {
              const parts: string[] = [];
              if (additions.emotion) parts.push('情绪=' + additions.emotion + (additions.emotion_degree ? '(' + additions.emotion_degree + ')' : ''));
              if (additions.gender) parts.push('性别=' + additions.gender);
              if (additions.speech_rate) parts.push('语速=' + parseFloat(additions.speech_rate).toFixed(1) + 'token/s');
              if (additions.volume) parts.push('音量=' + parseFloat(additions.volume).toFixed(0) + 'dB');
              if (parts.length > 0) agentText = '[副语言: ' + parts.join(', ') + ']\n' + text;
            }

            try {
              const handleToken = (token: string) => {
                if (stopped || myGeneration !== generation) return;
                if (!firstTokenAt) firstTokenAt = Date.now();
                send({ type: 'reply_text', turnId, text: token });
              };
              const handleSentence = (sentence: string) => {
                if (!firstSentenceAt) firstSentenceAt = Date.now();
                const ttsStartAt = Date.now();
                const ttsPromise = streamTTS(sentence, (chunk) => {
                  if (stopped || myGeneration !== generation) return;
                  if (!firstTtsAt) firstTtsAt = Date.now();
                  send({ type: 'audio_chunk', turnId, audioChunk: chunk.toString('base64') });
                }).then(() => {}).catch(() => {});
                pendingTts.push(ttsPromise);
              };

              const fullReply = await streamChatViaTestServer(
                agentText,
                { proxyBase: gw.proxyBase, agentId: gw.agentId, sessionKey: gw.sessionKey, queueMode: gw.queueMode },
                handleToken,
                handleSentence,
                (m) => {
                  if (m.metric === 'gateway_first_delta') {
                    if (typeof m.at === 'number') proxyGatewayFirstDeltaAt = m.at;
                    if (typeof m.ms === 'number') proxyGatewayFirstDeltaMs = m.ms;
                  }
                },
                (toolData) => {
                  if (stopped || myGeneration !== generation) return;
                  send({ type: 'tool_event', turnId, ...toolData });
                }
              );

              await Promise.all(pendingTts);
              if (stopped || myGeneration !== generation) return;
              const replyDoneAt = Date.now();
              if (fullReply) send({ type: 'history_entry', text: fullReply, role: 'assistant' });
              send({
                type: 'reply_done',
                turnId,
                metrics: {
                  asrFinalAt,
                  firstTokenAt,
                  firstSentenceAt,
                  firstAudioAt: firstTtsAt,
                  proxyGatewayFirstDeltaAt,
                  proxyGatewayFirstDeltaMs,
                  asrToFirstTokenMs: firstTokenAt ? firstTokenAt - asrFinalAt : null,
                  asrToFirstAudioMs: firstTtsAt ? firstTtsAt - asrFinalAt : null,
                },
              });
              if (gw.sessionKey) touchSession(gw.sessionKey);
            } catch (e: any) {
              if (stopped || myGeneration !== generation) return;
              send({ type: 'error', turnId, error: e.message || String(e) });
            }
          },
          gw.enableBargeIn ? () => { generation++; send({ type: 'barge_in' }); } : undefined
        );
        asrSession.start();
      }
      if (msg.type === 'stop') {
        stopped = true;
        generation++;
        asrSession?.finish();
      }
      return;
    }
    if (!stopped) asrSession?.feedPcmChunk(Buffer.from(raw as Buffer));
  });

  client.on('close', () => {
    stopped = true;
    asrSession?.close();
  });

  client.on('error', (err) => {
    console.log('[PARA] ws error', (err as any)?.message || err);
  });
});

wssPhase2.on('connection', (client, req) => {
  console.log('[PHASE2] ws connected from', req.socket.remoteAddress);
  let asrSession: StreamingAsrSession | null = null;
  let stopped = false;
  let turnCounter = 0;
  let generation = 0; // bump on each new turn / barge-in to drop stale streams
  let gw = {
    gatewayUrl: 'http://127.0.0.1:18789',
    gatewayToken: '',
    model: 'openai-codex/gpt-5.3-codex',
    tag: 'voiceclaw-phase2',
    proxyBase: 'http://127.0.0.1:3456',
    agentId: 'voice',
    chatMode: 'proxy',
    enableBargeIn: false,
    sessionKey: '',
  };

  const send = (data: unknown) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  };

  client.on('message', async (raw, isBinary) => {
    if (!isBinary) {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'start') {
        console.log('[PHASE2] start', {
          proxyBase: msg.proxyBase,
          agentId: msg.agentId,
          chatMode: msg.chatMode,
          sessionKey: msg.sessionKey,
        });
        stopped = false;
        turnCounter = 0;
        gw = {
          gatewayUrl: msg.gatewayUrl || gw.gatewayUrl,
          gatewayToken: msg.gatewayToken || '',
          model: msg.model || gw.model,
          tag: msg.tag || gw.tag,
          proxyBase: msg.proxyBase || gw.proxyBase,
          agentId: msg.agentId || gw.agentId,
          chatMode: msg.chatMode || gw.chatMode,
          enableBargeIn: !!msg.enableBargeIn,
          sessionKey: msg.sessionKey || '',
        };

        asrSession = new StreamingAsrSession(
          send,
          async (text) => {
            if (stopped) return;
            const turnId = ++turnCounter;
            const myGeneration = ++generation;
            const asrFinalAt = Date.now();
            const llmStartAt = Date.now();
            let proxyGatewayFirstDeltaAt: number | null = null;
            let proxyGatewayFirstDeltaMs: number | null = null;
            let firstTokenAt: number | null = null;
            let firstSentenceAt: number | null = null;
            let firstTtsAt: number | null = null;
            const ttsTimings: number[] = [];
            const pendingTts: Promise<void>[] = [];
            let fullReply = '';

            try {
              const handleToken = (token: string) => {
                if (stopped || myGeneration !== generation) return;
                if (!firstTokenAt) firstTokenAt = Date.now();
                send({ type: 'reply_text', turnId, text: token });
              };
              const handleSentence = (sentence: string) => {
                if (!firstSentenceAt) firstSentenceAt = Date.now();
                const ttsStartAt = Date.now();
                const ttsPromise = streamTTS(sentence, (chunk) => {
                  if (stopped || myGeneration !== generation) return;
                  if (!firstTtsAt) firstTtsAt = Date.now();
                  send({ type: 'audio_chunk', turnId, audioChunk: chunk.toString('base64') });
                }).then(() => {
                  ttsTimings.push(Date.now() - ttsStartAt);
                }).catch(() => {});
                pendingTts.push(ttsPromise);
              };

              if (gw.chatMode === 'direct') {
                fullReply = await streamChatWithOpenClaw(text, gw, handleToken, handleSentence);
              } else {
                fullReply = await streamChatViaTestServer(
                  text,
                  gw,
                  handleToken,
                  handleSentence,
                  (m) => {
                    if (m.metric === 'gateway_first_delta') {
                      if (typeof m.at === 'number') proxyGatewayFirstDeltaAt = m.at;
                      if (typeof m.ms === 'number') proxyGatewayFirstDeltaMs = m.ms;
                    }
                  },
                  (toolData) => {
                    if (stopped || myGeneration !== generation) return;
                    send({ type: 'tool_event', turnId, ...toolData });
                  }
                );
              }

              await Promise.all(pendingTts);
              if (stopped || myGeneration !== generation) return;
              const llmDoneAt = Date.now();
              const replyDoneAt = Date.now();
              const totalTtsMs = ttsTimings.reduce((a, b) => a + b, 0);
              const metrics = {
                asrFinalAt,
                llmStartAt,
                firstTokenAt,
                firstSentenceAt,
                firstAudioAt: firstTtsAt,
                proxyGatewayFirstDeltaAt,
                proxyGatewayFirstDeltaMs,
                llmDoneAt,
                replyDoneAt,
                llmMs: llmDoneAt - llmStartAt,
                ttsMs: totalTtsMs,
                firstAudioLatency: firstTtsAt ? firstTtsAt - llmStartAt : null,
                asrToFirstTokenMs: firstTokenAt ? firstTokenAt - asrFinalAt : null,
                asrToFirstSentenceMs: firstSentenceAt ? firstSentenceAt - asrFinalAt : null,
                asrToFirstAudioMs: firstTtsAt ? firstTtsAt - asrFinalAt : null,
                asrToReplyDoneMs: replyDoneAt - asrFinalAt,
              };
              console.log('[PHASE2_METRICS]', JSON.stringify({ turnId, metrics }));

              send({
                type: 'reply_done',
                turnId,
                text: fullReply,
                metrics,
              });
              if (gw.sessionKey) touchSession(gw.sessionKey);
            } catch (e: any) {
              if (stopped || myGeneration !== generation) return;
              send({ type: 'error', turnId, error: e.message || String(e) });
            }
          },
          gw.enableBargeIn
            ? () => {
                generation += 1;
                send({ type: 'barge_in' });
              }
            : undefined
        );
        asrSession.start();
      }
      if (msg.type === 'stop') {
        stopped = true;
        generation += 1;
        asrSession?.finish();
      }
      return;
    }

    if (!stopped) asrSession?.feedPcmChunk(Buffer.from(raw as Buffer));
  });

  client.on('close', () => {
    console.log('[PHASE2] ws closed');
    stopped = true;
    asrSession?.close();
  });

  client.on('error', (err) => {
    console.log('[PHASE2] ws error', (err as any)?.message || err);
  });
});

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;

  if (pathname === '/ws/phase2-claw') {
    wssPhase2.handleUpgrade(req, socket, head, (ws) => {
      wssPhase2.emit('connection', ws, req);
    });
    return;
  }

  if (pathname === '/ws/para-claw') {
    wssParaClaw.handleUpgrade(req, socket, head, (ws) => {
      wssParaClaw.emit('connection', ws, req);
    });
    return;
  }

  socket.destroy();
});

const port = Number(process.env.VOICECLAW_TEST_PORT || 3017);
server.listen(port, () => {
  console.log(`VoiceClaw test page: http://127.0.0.1:${port}`);
});
