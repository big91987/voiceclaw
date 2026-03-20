/**
 * GatewayClient — shared module for OpenClaw gateway connection
 * Extracted from test-server.ts for reuse by app-server.ts and test-server.ts
 */

import { readFileSync } from 'fs';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

export const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789';
export const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '53f48388b0c74d7eb8aded3b643afd6b';

// ED25519 SPKI prefix
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

// 从文件加载 device identity
export function loadDeviceIdentity(): DeviceIdentity | null {
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

export function deriveDeviceId(publicKeyPem: string): string {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: 'spki', format: 'der' }) as Buffer;
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
      spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    const rawPublicKey = spki.subarray(ED25519_SPKI_PREFIX.length);
    return crypto.createHash('sha256').update(rawPublicKey).digest('hex');
  }
  return crypto.createHash('sha256').update(spki).digest('hex');
}

export function buildDeviceAuthPayload(params: {
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

export function signData(payload: string, privateKeyPem: string): string {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url');
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private device: DeviceIdentity;
  private connectNonce: string | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((err: Error) => void) | null = null;
  private pendingResolves = new Map<string, (value: any) => void>();
  private reqId = 0;
  private agentSessionKeys = new Map<string, string>();
  private eventHandlers: ((event: unknown) => void)[] = [];

  constructor(device: DeviceIdentity) {
    this.device = device;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;

      this.ws = new WebSocket(GATEWAY_URL, {
        headers: { 'Origin': 'http://localhost:3100' },
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

  /**
   * Generic RPC call — sends a req frame and resolves with the payload.
   */
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.ws) throw new Error('Not connected');
    const id = `req-${++this.reqId}`;
    const frame = { type: 'req', id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResolves.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, 8000);
      this.pendingResolves.set(id, (res: any) => {
        clearTimeout(timeout);
        if (res.ok === false) reject(new Error(res.error?.message || method + ' failed'));
        else resolve(res.payload);
      });
      this.ws!.send(JSON.stringify(frame));
    });
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
        ...(opts?.queueMode ? { queueMode: opts.queueMode } : {}),
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
