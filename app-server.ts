/**
 * OpenClaw App Server — production chat UI
 * Port 3100, serves src/app/ static files + proxies to OpenClaw gateway
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync, readdirSync, createReadStream, appendFileSync } from 'fs';
import { join, extname } from 'path';
import { createInterface } from 'readline';
import { gzipSync, gunzipSync } from 'zlib';
import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { loadDeviceIdentity, GatewayClient } from './src/gateway-client';
import { config } from './src/config';

const LOG_FILE = '/tmp/voiceclaw-asr.log';
function log(...args: unknown[]) { appendFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\n'); }

const PORT = 3100;
const APP_DIR = join(__dirname, 'src/app');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.ico':  'image/x-icon',
};

function serveStatic(res: ServerResponse, filePath: string) {
  if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  const ext = extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
}

// ── Gateway connection ─────────────────────────────────────
let gatewayClient: GatewayClient | null = null;
let gatewayReady = false;

async function ensureGateway(): Promise<GatewayClient> {
  if (gatewayClient && gatewayReady && gatewayClient.isConnected()) return gatewayClient;
  gatewayReady = false;
  const device = loadDeviceIdentity();
  if (!device) throw new Error('Device not paired');
  const client = new GatewayClient(device);
  await client.connect();
  gatewayClient = client;
  gatewayReady = true;
  // Forward all gateway events to SSE subscribers
  gatewayClient.onEvent((event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const sub of eventSubscribers) {
      try { sub.write(data); } catch { eventSubscribers.delete(sub); }
    }
  });
  // Handle disconnect → reset so next call reconnects
  client.onClose(() => { gatewayReady = false; });
  return gatewayClient;
}

// ── SSE event subscribers ──────────────────────────────────
const eventSubscribers = new Set<ServerResponse>();

// ── ASR binary protocol helpers ───────────────────────────
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

// ── StreamingAsrSession ───────────────────────────────────
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
  private replyVersion = 0;
  private processedUtteranceIds = new Set<string>();
  private currentTurnText = '';
  private lastProcessedText = '';
  private lastUtteranceCount = 0;
  private bargeInSent = false;

  constructor(
    private sendEvent: (data: unknown) => void,
    private onFinal: (text: string) => Promise<void>,
    private onBargeIn?: () => void,
  ) {}

  start() {
    this.closed = false;
    this.ready = false;
    this.nextSeq = 2;
    this.connectAttempts = 0;
    this.currentTurnText = '';
    this.lastProcessedText = '';
    this.processedUtteranceIds.clear();
    this.openSocket();
  }

  private openSocket() {
    if (this.closed) return;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.reconnectScheduled = false;

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
      log('[ASR server] ByteDance WS open');
      this.connectAttempts = 0;
      this.ws?.send(asrFullClientRequest({
        user: { uid: uuidv4() },
        audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1, language: 'zh-CN' },
        request: {
          model_name: 'bigmodel',
          enable_itn: true,
          enable_punc: true,
          show_utterances: true,
          end_window_size: 800,
        },
      }));
    });

    this.ws.on('message', async (raw) => {
      const msg = parseAsr(Buffer.from(raw as Buffer));
      if (msg.type === 15) { log('[ASR server] type=15 error:', msg.payload); this.sendEvent({ type: 'error', error: msg.payload }); return; }
      if (msg.type !== 9) return;
      log('[ASR server] type=9 received');
      try {
        const parsed = JSON.parse(msg.payload);
        log('[ASR server] raw payload:', JSON.stringify(parsed).slice(0, 500));
        const text = parsed?.result?.text || '';
        const utterances: any[] = parsed?.result?.utterances || [];
        const definiteUtterances = utterances.filter((u: any) => u?.definite === true);
        const hasDefinite = definiteUtterances.length > 0;
        log('[ASR server] text=', JSON.stringify(text), 'utterances=', utterances.length, 'definite=', definiteUtterances.length);

        if (!this.ready) { this.ready = true; log('[ASR server] ready'); this.sendEvent({ type: 'ready' }); }

        let displayText = text || '';
        if (this.lastProcessedText && displayText) {
          const norm = this.lastProcessedText.trim();
          const disp = displayText.trim();
          if (disp.startsWith(norm)) {
            displayText = disp.slice(norm.length).trim().replace(/^[，。！？,.!?\s]+/, '');
          }
        }
        if (displayText) { log('[ASR server] partial:', displayText); this.sendEvent({ type: 'partial', text: displayText, hasDefinite }); }

        if (this.onBargeIn && utterances.length > this.lastUtteranceCount && this.runningReply && !this.bargeInSent) {
          log('[ASR server] barge_in triggered');
          this.bargeInSent = true;
          this.runningReply = false;
          this.currentTurnText = '';
          this.replyVersion++;
          this.sendEvent({ type: 'barge_in' });
          this.onBargeIn?.();
        }
        this.lastUtteranceCount = utterances.length;

        if (hasDefinite && !this.runningReply) {
          const newDef = definiteUtterances.filter((u: any) => {
            const uid = u?.utterance_id || u?.start_time;
            if (!this.processedUtteranceIds.has(uid)) { this.processedUtteranceIds.add(uid); return true; }
            return false;
          });
          if (newDef.length > 0) {
            const turnText = newDef.map((u: any) => String(u?.text || '').trim()).filter(Boolean).join(' ');
            if (turnText) this.currentTurnText += (this.currentTurnText ? ' ' : '') + turnText;
          }
          if (this.currentTurnText) {
            log('[ASR server] triggering final with definite text:', this.currentTurnText);
            this.runningReply = true;
            const myVersion = ++this.replyVersion;
            const finalText = this.currentTurnText;
            this.sendEvent({ type: 'final', text: finalText });
            this.lastProcessedText = text;
            this.onFinal(finalText).finally(() => {
              if (this.replyVersion !== myVersion) return;
              this.runningReply = false;
              this.currentTurnText = '';
              this.bargeInSent = false;
            });
          }
        }
      } catch (e) { console.error('[ASR] parse error:', e); }
    });

    this.ws.on('close', () => {
      if (!this.closed && !this.ready) { this.scheduleReconnect('closed before ready'); return; }
      this.sendEvent({ type: 'closed' });
    });
    this.ws.on('error', (err) => {
      const message = err?.message || String(err);
      if (!this.closed && !this.ready) { this.scheduleReconnect(`ws error: ${message}`); return; }
      this.sendEvent({ type: 'error', error: message });
    });
  }

  private scheduleReconnect(reason: string) {
    if (this.closed || this.reconnectScheduled) return;
    this.connectAttempts += 1;
    if (this.connectAttempts >= this.maxConnectAttempts) {
      this.sendEvent({ type: 'error', error: `${reason} (retry exhausted)` }); return;
    }
    this.reconnectScheduled = true;
    const delayMs = Math.min(800 * this.connectAttempts, 3000);
    this.reconnectTimer = setTimeout(() => this.openSocket(), delayMs);
  }

  feedPcmChunk(chunk: Buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready || this.closed || !chunk.length) { log('[ASR server] feedPcmChunk skipped, wsReady=', this.ws?.readyState, 'ready=', this.ready, 'closed=', this.closed, 'chunkLen=', chunk.length); return; }
    log('[ASR server] feedPcmChunk', chunk.length, 'bytes');
    for (let off = 0; off < chunk.length; off += 6400) {
      const piece = chunk.subarray(off, off + 6400);
      if (piece.length) this.ws.send(asrAudioOnly(this.nextSeq++, piece));
    }
  }

  stop() {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { this.ws.close(); this.ws = null; }
  }
}

// ── TtsConnection ─────────────────────────────────────────
class TtsConnection {
  private ws: WebSocket | null = null;
  private sessionId: string;
  private ready = false;
  private pendingQueue: { text: string; onChunk: (chunk: Buffer) => void; onDone: () => void; onError: (e: Error) => void }[] = [];
  private currentJob: { text: string; onChunk: (chunk: Buffer) => void; onDone: () => void; onError: (e: Error) => void } | null = null;
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

    this.ws.on('open', () => { this.ws?.send(this.makeEvent(1, null, {})); });

    this.ws.on('message', (raw) => {
      const data = Buffer.from(raw as Buffer);
      const type = (data[1] >> 4) & 0x0f;
      const flag = data[1] & 0x0f;
      let offset = 4;
      let event: number | null = null;
      if (flag & 4) {
        event = data.readInt32BE(offset); offset += 4;
        if (event >= 100) { const sidLen = data.readUInt32BE(offset); offset += 4 + sidLen; }
      }
      const len = data.readUInt32BE(offset); offset += 4;
      const payload = data.slice(offset, offset + len);

      if (type === 9 && event === 50) {
        this.ready = true; this.processQueue();
      } else if (type === 9 && event === 150) {
        if (this.currentJob) {
          this.ws?.send(this.makeEvent(200, this.sessionId, {
            user: { uid: uuidv4() },
            req_params: { speaker: 'zh_female_vv_uranus_bigtts', text: (this.currentJob as any).text, audio_params: { format: 'mp3', sample_rate: 24000 } },
          }));
          this.ws?.send(this.makeEvent(102, this.sessionId, {}));
        }
      } else if (type === 11 || (type === 9 && event === 352)) {
        this.currentJob?.onChunk(payload);
      } else if (type === 9 && event === 152) {
        this.currentJob?.onDone(); this.currentJob = null; this.processQueue();
      } else if (type === 15) {
        const err = new Error(payload.toString());
        this.currentJob?.onError(err); this.currentJob = null; this.processQueue();
      }
    });

    this.ws.on('error', (err) => { this.failCurrentJob(err as Error); });
    this.ws.on('close', () => {
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
    if (job) job.onError(err);
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
    if (!this.ready || this.currentJob || this.pendingQueue.length === 0) return;
    const job = this.pendingQueue.shift()!;
    this.currentJob = job;
    this.sessionId = uuidv4();
    this.ws?.send(this.makeEvent(100, this.sessionId, {
      user: { uid: uuidv4() },
      req_params: { speaker: 'zh_female_vv_uranus_bigtts', audio_params: { format: 'mp3', sample_rate: 24000 } },
    }));
  }

  synthesize(text: string, onChunk: (chunk: Buffer) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onDone = () => { if (settled) return; settled = true; clearTimeout(timeout); resolve(); };
      const onError = (err: Error) => { if (settled) return; settled = true; clearTimeout(timeout); reject(err); };
      const timeout = setTimeout(() => {
        if (settled) return; settled = true;
        const idx = this.pendingQueue.findIndex(j => j.onDone === onDone);
        if (idx >= 0) this.pendingQueue.splice(idx, 1);
        else if (this.currentJob?.onDone === onDone) { this.currentJob = null; this.processQueue(); }
        reject(new Error('TTS timeout'));
      }, 30000);
      this.pendingQueue.push({ text, onChunk, onDone, onError });
      this.processQueue();
    });
  }

  close() { this.ws?.close(); }
}

let globalTtsConn: TtsConnection | null = null;

// ── HTTP Server ────────────────────────────────────────────
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url || '/';

  // Health check
  if (url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /api/agents
  if (url === '/api/agents' && req.method === 'GET') {
    try {
      const client = await ensureGateway();
      const result = await client.call('agents.list', {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // GET /api/sessions
  if (url.startsWith('/api/sessions') && req.method === 'GET') {
    const agentId = new URL(url, 'http://x').searchParams.get('agentId') || undefined;
    try {
      const client = await ensureGateway();
      const result = await client.call('sessions.list', agentId ? { agentId } : {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // GET /api/openclaw/sessions — scan openclaw session files
  if (url.startsWith('/api/openclaw/sessions') && req.method === 'GET') {
    const agentId = new URL(url, 'http://x').searchParams.get('agentId');
    if (!agentId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agentId required' }));
      return;
    }
    const openclawPath = expandPath(new URL(url, 'http://x').searchParams.get('openclawPath') || `${process.env.HOME}/.openclaw`);
    try {
      const sessionsDir = join(openclawPath, 'agents', agentId, 'sessions');
      if (!existsSync(sessionsDir)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions: [] }));
        return;
      }
      const files = readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl') && !f.includes('.deleted.') && !f.includes('.reset.'));
      const sessions = await Promise.all(files.map(async (file) => {
        const sessionId = file.replace('.jsonl', '');
        const filePath = join(sessionsDir, file);
        return getSessionInfo(filePath, sessionId);
      }));
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // GET /api/openclaw/history — parse session .jsonl for messages
  if (url.startsWith('/api/openclaw/history') && req.method === 'GET') {
    const sessionId = new URL(url, 'http://x').searchParams.get('sessionId');
    const agentId = new URL(url, 'http://x').searchParams.get('agentId');
    const openclawPath = expandPath(new URL(url, 'http://x').searchParams.get('openclawPath') || `${process.env.HOME}/.openclaw`);
    if (!sessionId || !agentId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'sessionId and agentId required' }));
      return;
    }
    try {
      const filePath = join(openclawPath, 'agents', agentId, 'sessions', `${sessionId}.jsonl`);
      if (!existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session file not found' }));
        return;
      }
      const messages = await parseSessionHistory(filePath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // GET /api/events — permanent SSE
  if (url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');
    eventSubscribers.add(res);
    req.on('close', () => eventSubscribers.delete(res));
    ensureGateway().catch(e => console.error('[Gateway] events connect failed:', e));
    return; // keep open
  }

  // POST /api/chat — SSE stream
  if (url === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { message, agentId, reuseSession, sessionKey, queueMode } = JSON.parse(body);
        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Message required' })); return;
        }
        if (!agentId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'agentId required' })); return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const apiStartAt = Date.now();
        let firstGatewayDeltaAt: number | null = null;
        let targetRunId: string | undefined;
        let targetSessionKey: string | undefined;

        // 使用全局预连接的 GatewayClient（复用连接，避免每次新建）
        const chatClient = await ensureGateway();

        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          res.end();
        };

        const eventHandler = (event: unknown) => {
          const e = event as Record<string, unknown>;
          const payload =
            e.payload && typeof e.payload === 'object'
              ? (e.payload as Record<string, unknown>)
              : {};
          const eventRunId = typeof payload.runId === 'string' ? payload.runId : '';
          const eventSessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : '';
          const matchesRun = !!targetRunId && eventRunId === targetRunId;
          const matchesSession = !!targetSessionKey && eventSessionKey === targetSessionKey;
          const shouldForward = targetRunId
            ? (matchesRun || (!eventRunId && matchesSession))
            : matchesSession;

          if (!shouldForward) {
            return;
          }

          res.write(`data: ${JSON.stringify(e)}\n\n`);

          if (e.event === 'agent') {
            const stream = payload?.stream;
            const delta = (payload?.data as Record<string, unknown> | undefined)?.delta;
            if (stream === 'assistant' && typeof delta === 'string' && delta.length > 0 && !firstGatewayDeltaAt) {
              firstGatewayDeltaAt = Date.now();
              const metric = {
                type: 'metric', metric: 'gateway_first_delta',
                at: firstGatewayDeltaAt, ms: firstGatewayDeltaAt - apiStartAt,
              };
              res.write(`data: ${JSON.stringify(metric)}\n\n`);
            }
          }

          if (e.event === 'chat') {
            if (payload.state === 'final' || payload.state === 'error') {
              res.write('data: [DONE]\n\n');
              finish();
            }
          }
        };

        chatClient.onEvent(eventHandler);

        const started = await chatClient.sendAgentMessage(message, agentId, {
          reuseSession: !!reuseSession,
          sessionKey: sessionKey || '',
          queueMode: queueMode || 'interrupt',
        });
        targetRunId = started.runId;
        targetSessionKey = started.sessionKey;
        res.write(`data: ${JSON.stringify({
          type: 'metric', metric: 'session_start',
          runId: targetRunId, sessionKey: targetSessionKey, reuseSession: !!reuseSession,
        })}\n\n`);

        setTimeout(() => {
          if (finished) return;
          res.write('data: [TIMEOUT]\n\n');
          finish();
        }, 60000);

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  // POST /api/tts — stream MP3
  if (url === '/api/tts' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        if (!text) { res.writeHead(400); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Transfer-Encoding': 'chunked' });
        if (!globalTtsConn) globalTtsConn = new TtsConnection();
        await globalTtsConn.synthesize(text, (chunk) => res.write(chunk));
      } catch (e) {
        console.error('[TTS]', e);
      }
      res.end();
    });
    return;
  }

  // POST /api/chat/abort — abort an in-flight chat run
  if (url === '/api/chat/abort' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { runId, sessionKey } = JSON.parse(body);
        const client = await ensureGateway();
        const result = await client.abortRun(sessionKey, runId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // Static files
  const filePath = url === '/'
    ? join(APP_DIR, 'index.html')
    : join(APP_DIR, url.replace(/^\//, ''));
  serveStatic(res, filePath);
});

// ── WebSocket server for ASR ──────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  if (req.url !== '/ws/asr') { ws.close(); return; }
  log('[ASR server] client WS connected');

  const send = (data: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  };

  const session = new StreamingAsrSession(
    send,
    async (text) => { send({ type: 'final_ack', text }); },
    () => { send({ type: 'barge_in' }); },
  );

  session.start();

  ws.on('message', (data) => {
    const sz = Buffer.isBuffer(data) ? data.byteLength : (data instanceof ArrayBuffer ? data.byteLength : 0);
    log('[ASR server] WS msg, size=', sz);
    if (Buffer.isBuffer(data)) session.feedPcmChunk(data);
    else if (data instanceof ArrayBuffer) session.feedPcmChunk(Buffer.from(data));
  });

  ws.on('close', () => session.stop());
});

// ── OpenClaw session file helpers ──────────────────────────
function expandPath(p: string): string {
  if (p.startsWith('~/')) return join(process.env.HOME || '', p.slice(2));
  if (p === '~') return process.env.HOME || '';
  return p;
}

interface SessionInfo {
  sessionId: string;
  lastMessagePreview: string;
  createdAt: number;
  updatedAt: number;
}

async function getSessionInfo(filePath: string, sessionId: string): Promise<SessionInfo> {
  return new Promise((resolve) => {
    const rl = createInterface(createReadStream(filePath));
    let createdAt = 0;
    let updatedAt = 0;
    let lastMessagePreview = '';

    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line);
        const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : (obj.message?.timestamp || 0);

        // First line with type=session gives us createdAt
        if (obj.type === 'session' && !createdAt) {
          createdAt = ts;
        }

        // Track latest timestamp for updatedAt
        if (ts > updatedAt) updatedAt = ts;

        // Scan from bottom for last message preview
        if (obj.type === 'message' && obj.message?.content && !lastMessagePreview) {
          const content = obj.message.content;
          if (Array.isArray(content)) {
            const text = content.find((c: any) => c.type === 'text')?.text || '';
            lastMessagePreview = text.slice(0, 60);
          } else if (typeof content === 'string') {
            lastMessagePreview = content.slice(0, 60);
          }
        }
      } catch {}
    });
    rl.on('close', () => resolve({ sessionId, lastMessagePreview, createdAt, updatedAt }));
    rl.on('error', () => resolve({ sessionId, lastMessagePreview: '', createdAt: 0, updatedAt: 0 }));
  });
}

async function parseSessionHistory(filePath: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const rl = createInterface(createReadStream(filePath));
    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'message' && obj.message) {
          const { role, content, timestamp, toolCallId, toolName } = obj.message;
          messages.push({ role, content, timestamp, toolCallId, toolName });
        }
      } catch {}
    });
    rl.on('close', () => resolve(messages));
    rl.on('error', reject);
  });
}

server.listen(PORT, () => {
  console.log(`App server running at http://localhost:${PORT}`);
  ensureGateway().catch(e => console.error('[Gateway] pre-connect failed:', e));
});
