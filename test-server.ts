/**
 * VoiceClaw 测试服务器
 * 提供 HTTP API 供前端页面调用，处理 WebSocket 连接和 Device Identity
 */

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

const GATEWAY_URL = 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = '53f48388b0c74d7eb8aded3b643afd6b';
const AGENT_ID = 'voice';
const PORT = 3456;

// ED25519 SPKI prefix
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

// 从文件加载 device identity
function loadDeviceIdentity(): DeviceIdentity | null {
  try {
    const path = `${process.env.HOME}/.openclaw/voiceclaw-device.json`;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && parsed.deviceId && parsed.publicKeyPem && parsed.privateKeyPem) {
      return {
        deviceId: parsed.deviceId,
        publicKeyPem: parsed.publicKeyPem,
        privateKeyPem: parsed.privateKeyPem,
      };
    }
  } catch {
    // ignore
  }
  return null;
}

function deriveDeviceId(publicKeyPem: string): string {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: 'spki', format: 'der' }) as Buffer;
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
      spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    const rawPublicKey = spki.subarray(ED25519_SPKI_PREFIX.length);
    return crypto.createHash('sha256').update(rawPublicKey).digest('hex');
  }
  return crypto.createHash('sha256').update(spki).digest('hex');
}

function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  nonce: string;
  token?: string;
}): string {
  const scopes = params.scopes.join(',');
  const token = params.token ?? '';
  const platform = 'node';
  const deviceFamily = '';
  return [
    'v3', params.deviceId, params.clientId, params.clientMode,
    params.role, scopes, String(params.signedAtMs), token,
    params.nonce, platform, deviceFamily,
  ].join('|');
}

function signData(payload: string, privateKeyPem: string): string {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url');
}

class GatewayClient {
  private ws: WebSocket | null = null;
  private device: DeviceIdentity;
  private connectNonce: string | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((err: Error) => void) | null = null;
  private pendingResolves = new Map<string, (value: any) => void>();
  private reqId = 0;
  private agentSessionKeys = new Map<string, string>();

  constructor(device: DeviceIdentity) {
    this.device = device;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;

      this.ws = new WebSocket(GATEWAY_URL, {
        headers: { 'Origin': `http://localhost:${PORT}` },
      });

      this.ws.on('open', () => {
        console.log('[WS] Connected, waiting for challenge...');
      });

      this.ws.on('message', (data) => {
        try {
          const frame = JSON.parse(data.toString());
          this.handleFrame(frame);
        } catch {}
      });

      this.ws.on('error', reject);
      this.ws.on('close', () => {
        console.log('[WS] Closed');
      });
    });
  }

  private handleFrame(frame: Record<string, unknown>) {
    // Dispatch events to handlers
    if (frame.type === 'event') {
      this.eventHandlers.forEach(h => h(frame));
    }

    if (frame.type === 'event' && frame.event === 'connect.challenge') {
      const payload = frame.payload as Record<string, unknown>;
      this.connectNonce = payload.nonce as string;
      this.sendConnect();
      return;
    }

    if (frame.type === 'res') {
      const payload = frame.payload as Record<string, unknown>;
      if (payload?.type === 'hello-ok') {
        console.log('[WS] Auth success');
        this.resolveConnect?.();
        return;
      }

      const id = frame.id as string;
      const resolve = this.pendingResolves.get(id);
      if (resolve) {
        resolve(frame);
        this.pendingResolves.delete(id);
      }
      return;
    }
  }

  private sendConnect() {
    if (!this.connectNonce || !this.ws) return;

    const id = `req-${++this.reqId}`;
    const scopes = ['operator.admin', 'operator.write'];
    const role = 'operator';
    const clientId = 'gateway-client';
    const clientMode = 'backend';

    const signedAtMs = Date.now();
    const payload = buildDeviceAuthPayload({
      deviceId: this.device.deviceId,
      clientId, clientMode, role, scopes,
      signedAtMs, nonce: this.connectNonce, token: GATEWAY_TOKEN,
    });
    const signature = signData(payload, this.device.privateKeyPem);

    const connectReq = {
      type: 'req', id, method: 'connect',
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: clientId, version: '1.0.0', platform: 'node', mode: clientMode },
        auth: { token: GATEWAY_TOKEN },
        role, scopes, caps: [],
        device: {
          id: this.device.deviceId,
          publicKey: this.device.publicKeyPem,
          signedAt: signedAtMs,
          nonce: this.connectNonce,
          signature,
        },
      },
    };

    this.ws.send(JSON.stringify(connectReq));
  }

  async sendAgentMessage(
    message: string,
    agentId: string,
    opts?: { reuseSession?: boolean; sessionKey?: string; queueMode?: string },
  ): Promise<{ frame: any; sessionKey: string; runId?: string }> {
    if (!this.ws) throw new Error('Not connected');

    const id = `req-${++this.reqId}`;
    const explicitSessionKey = opts?.sessionKey?.trim();
    let sessionKey = explicitSessionKey || '';
    if (!sessionKey) {
      if (opts?.reuseSession) {
        // Reuse a sticky sessionKey per agent when the caller explicitly wants continuity.
        sessionKey = this.agentSessionKeys.get(agentId) || '';
        if (!sessionKey) {
          sessionKey = `agent:${agentId}:web-sticky-${uuidv4()}`;
          this.agentSessionKeys.set(agentId, sessionKey);
        }
      } else {
        sessionKey = `agent:${agentId}:web-${uuidv4()}`;
      }
    }

    const reqFrame = {
      type: 'req', id, method: 'agent',
      params: {
        message,
        agentId,
        sessionKey,
        idempotencyKey: uuidv4(),
        deliver: false,
      },
    };

    return new Promise((resolve) => {
      this.pendingResolves.set(id, (frame: any) => {
        const runId = typeof frame?.payload?.runId === 'string' ? frame.payload.runId : undefined;
        resolve({ frame, sessionKey, runId });
      });
      this.ws!.send(JSON.stringify(reqFrame));
    });
  }

  private eventHandlers: ((event: unknown) => void)[] = [];

  onEvent(handler: (event: unknown) => void) {
    this.eventHandlers.push(handler);
  }

  offEvent(handler: (event: unknown) => void) {
    this.eventHandlers = this.eventHandlers.filter(h => h !== handler);
  }

  close() {
    this.ws?.close();
  }
}

// HTTP Server
const server = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = req.url || '/';

  // API: Check device status
  if (url === '/api/status') {
    const device = loadDeviceIdentity();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      hasDevice: !!device,
      deviceId: device?.deviceId.slice(0, 16) + '...',
    }));
    return;
  }

  // API: List agents
  if (url === '/api/agents') {
    const device = loadDeviceIdentity();
    if (!device) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Device not paired' }));
      return;
    }

    try {
      const client = new GatewayClient(device);
      await client.connect();

      // Call agents.list method
      const id = `req-${Date.now()}`;
      const reqFrame = {
        type: 'req', id, method: 'agents.list',
        params: {},
      };

      const agents = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);

        // Override connect response handler temporarily
        const originalHandler = client['handleFrame'];
        client['pendingResolves'].set(id, (frame: any) => {
          clearTimeout(timeout);
          if (frame.ok && frame.payload?.agents) {
            resolve(frame.payload.agents);
          } else {
            reject(new Error(frame.error?.message || 'Failed to list agents'));
          }
        });

        client['ws']?.send(JSON.stringify(reqFrame));
      });

      client.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // API: Send message (SSE stream)
  if (url === '/api/chat' && req.method === 'POST') {
    const device = loadDeviceIdentity();
    if (!device) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Device not paired. Run: node openclaw.mjs devices approve --latest' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { message, agentId, reuseSession, sessionKey, queueMode } = JSON.parse(body);
        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Message required' }));
          return;
        }
        if (!agentId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'agentId required' }));
          return;
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

        // 使用全局预连接的 GatewayClient，如果没有则新建
        let client = globalGatewayClient;
        if (!client || !globalGatewayReady) {
          console.log('[Gateway] 全局连接未就绪，新建连接...');
          client = new GatewayClient(device);
          await client.connect();
        } else {
          console.log('[Gateway] 复用预连接');
        }

        // 先挂监听，再发送消息，避免事件竞态丢失
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          client.offEvent(eventHandler);
          if (client !== globalGatewayClient) {
            client.close();
          }
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

          console.log('[Gateway Event]', JSON.stringify(e).substring(0, 200));
          res.write(`data: ${JSON.stringify(e)}\n\n`);

          if (e.event === 'agent') {
            const stream = payload?.stream;
            const delta = (payload?.data as Record<string, unknown> | undefined)?.delta;
            if (stream === 'assistant' && typeof delta === 'string' && delta.length > 0 && !firstGatewayDeltaAt) {
              firstGatewayDeltaAt = Date.now();
              const metric = {
                type: 'metric',
                metric: 'gateway_first_delta',
                at: firstGatewayDeltaAt,
                ms: firstGatewayDeltaAt - apiStartAt,
              };
              console.log('[Gateway Metric]', metric);
              res.write(`data: ${JSON.stringify(metric)}\n\n`);
            }
          }

          // End on final or error
          if (e.event === 'chat') {
            console.log('[Gateway] chat event state:', payload.state);
            if (payload.state === 'final' || payload.state === 'error') {
              console.log('[Gateway] Sending [DONE]');
              res.write('data: [DONE]\n\n');
              finish();
            }
          }
        };
        client.onEvent(eventHandler);

        // Send message
        const started = await client.sendAgentMessage(message, agentId, {
          reuseSession: !!reuseSession,
          sessionKey: sessionKey || '',
          queueMode: queueMode || 'interrupt',
        });
        targetRunId = started.runId;
        targetSessionKey = started.sessionKey;
        res.write(`data: ${JSON.stringify({
          type: 'metric',
          metric: 'session_start',
          runId: targetRunId,
          sessionKey: targetSessionKey,
          reuseSession: !!reuseSession,
        })}\n\n`);

        // Timeout
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

  res.writeHead(404);
  res.end('Not found');
});

// 全局 Gateway 连接（预连接复用）
let globalGatewayClient: GatewayClient | null = null;
let globalGatewayReady = false;

async function initGateway(): Promise<void> {
  const device = loadDeviceIdentity();
  if (!device) {
    console.log('[Gateway] 未配置 Device，跳过预连接');
    return;
  }
  console.log('[Gateway] 正在预连接...');
  globalGatewayClient = new GatewayClient(device);
  try {
    await globalGatewayClient.connect();
    globalGatewayReady = true;
    console.log('[Gateway] 预连接成功，已就绪');
  } catch (err) {
    console.error('[Gateway] 预连接失败:', err);
    globalGatewayClient = null;
  }
}

server.listen(PORT, () => {
  console.log(`🚀 VoiceClaw 测试服务器已启动`);
  console.log(`📱 打开 http://localhost:${PORT} 查看测试页面`);
  console.log('');
  console.log('按 Ctrl+C 停止服务器');
  // 启动时预连接 Gateway
  initGateway();
});
