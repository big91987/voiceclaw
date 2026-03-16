import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

/**
 * OpenClaw Gateway WebSocket 协议测试
 *
 * 测试流程：
 * 1. WebSocket 连接
 * 2. 发送 connect frame (认证)
 * 3. 等待 hello-ok
 * 4. 发送 chat_send 请求
 * 5. 接收 chat_event 流式事件
 * 6. 接收 subagent 完成推送 (如果有)
 */

const GATEWAY_URL = 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = '53f48388b0c74d7eb8aded3b643afd6b'; // 你的 Gateway token
const AGENT_ID = 'voice'; // 要测试的 agent

interface TestOptions {
  message: string;
  expectSubagent?: boolean;
  useDeviceIdentity?: boolean;
}

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

interface StoredDeviceIdentity {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

// ED25519 SPKI prefix for raw public key extraction
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// Device identity storage path
const DEVICE_IDENTITY_PATH = `${process.env.HOME}/.openclaw/voiceclaw-device.json`;

class OpenClawWsClient {
  private ws: WebSocket | null = null;
  private reqId = 0;
  private pendingResolves = new Map<string, (value: unknown) => void>();
  private eventHandlers: ((event: unknown) => void)[] = [];
  private connected = false;
  private sessionKey: string;
  private connectNonce: string | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private device: DeviceIdentity | null = null;
  private connectFrameId: string = '';

  constructor(agentId: string, useDeviceIdentity: boolean = true) {
    // OpenClaw sessionKey 格式: agent:<agentId>:<mainKey>
    this.sessionKey = `agent:${agentId}:voiceclaw-ws-${Date.now()}`;

    if (useDeviceIdentity) {
      this.device = this.loadOrCreateDeviceIdentity();
    }
  }

  // 加载或生成 Ed25519 密钥对
  private loadOrCreateDeviceIdentity(): DeviceIdentity {
    // 先尝试从文件加载
    try {
      if (require('fs').existsSync(DEVICE_IDENTITY_PATH)) {
        const raw = require('fs').readFileSync(DEVICE_IDENTITY_PATH, 'utf8');
        const parsed = JSON.parse(raw) as StoredDeviceIdentity;
        if (
          parsed?.version === 1 &&
          typeof parsed.deviceId === 'string' &&
          typeof parsed.publicKeyPem === 'string' &&
          typeof parsed.privateKeyPem === 'string'
        ) {
          console.log(`[Device] 从文件加载设备身份: ${parsed.deviceId.slice(0, 16)}...`);
          return {
            deviceId: parsed.deviceId,
            publicKeyPem: parsed.publicKeyPem,
            privateKeyPem: parsed.privateKeyPem,
          };
        }
      }
    } catch {
      // 加载失败，继续生成新的
    }

    // 生成新的密钥对
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const deviceId = this.deriveDeviceId(publicKeyPem);

    // 保存到文件
    const stored: StoredDeviceIdentity = {
      version: 1,
      deviceId,
      publicKeyPem,
      privateKeyPem,
      createdAtMs: Date.now(),
    };
    try {
      require('fs').mkdirSync(require('path').dirname(DEVICE_IDENTITY_PATH), { recursive: true });
      require('fs').writeFileSync(DEVICE_IDENTITY_PATH, JSON.stringify(stored, null, 2), { mode: 0o600 });
      console.log(`[Device] 已生成并保存设备身份: ${deviceId.slice(0, 16)}...`);
    } catch (err) {
      console.warn('[Device] 保存设备身份失败:', err);
    }

    return { deviceId, publicKeyPem, privateKeyPem };
  }

  // 从公钥 PEM 计算 deviceId (SHA256 fingerprint)
  private deriveDeviceId(publicKeyPem: string): string {
    const key = crypto.createPublicKey(publicKeyPem);
    const spki = key.export({ type: 'spki', format: 'der' }) as Buffer;
    if (
      spki.length === ED25519_SPKI_PREFIX.length + 32 &&
      spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ) {
      const rawPublicKey = spki.subarray(ED25519_SPKI_PREFIX.length);
      return crypto.createHash('sha256').update(rawPublicKey).digest('hex');
    }
    return crypto.createHash('sha256').update(spki).digest('hex');
  }

  // 构建 Device Auth Payload (v3)
  // OpenClaw 使用 pipe-separated 字符串格式: "v3|deviceId|clientId|..."
  private buildDeviceAuthPayload(params: {
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
    const platform = 'node';  // normalizeDeviceMetadataForAuth 会用这个
    const deviceFamily = '';  // 可选，我们用空字符串
    return [
      'v3',
      params.deviceId,
      params.clientId,
      params.clientMode,
      params.role,
      scopes,
      String(params.signedAtMs),
      token,
      params.nonce,
      platform,
      deviceFamily,
    ].join('|');
  }

  // 签名数据
  private signData(payload: string): string {
    if (!this.device) throw new Error('Device identity not initialized');
    const privateKey = crypto.createPrivateKey(this.device.privateKeyPem);
    return crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url');
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      console.log(`[WS] 连接到 ${GATEWAY_URL}...`);

      this.ws = new WebSocket(GATEWAY_URL, {
        headers: {
          'Origin': 'http://localhost:3017',
        },
      });

      this.ws.on('open', () => {
        console.log('[WS] 连接已建立，等待 challenge...');
        // 等待服务端发送 connect.challenge
      });

      this.ws.on('message', (data) => {
        try {
          const frame = JSON.parse(data.toString());
          this.handleFrame(frame);
        } catch (err) {
          console.log('[WS] 收到非 JSON 数据:', data.toString().slice(0, 200));
        }
      });

      this.ws.on('error', (err) => {
        console.error('[WS] 错误:', err.message);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[WS] 连接关闭: code=${code}, reason=${reason}`);
        this.connected = false;
      });
    });
  }

  private sendConnect(useDeviceAuth: boolean = false) {
    if (!this.connectNonce || !this.ws) return;

    console.log('[WS] 发送 connect 请求...');
    if (useDeviceAuth && this.device) {
      console.log(`[WS] 使用 Device Identity: ${this.device.deviceId.slice(0, 16)}...`);
    }

    this.connectFrameId = `req-${++this.reqId}`;

    const scopes = ['operator.admin', 'operator.write'];
    const role = 'operator';
    const clientId = 'gateway-client';
    const clientMode = 'backend';

    const connectReq: Record<string, unknown> = {
      type: 'req',
      id: this.connectFrameId,
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: clientId,
          version: '1.0.0',
          platform: 'node',
          mode: clientMode,
        },
        auth: GATEWAY_TOKEN ? { token: GATEWAY_TOKEN } : undefined,
        role,
        scopes,
        caps: [],
      },
    };

    // 如果启用 device identity，添加 device 字段
    if (useDeviceAuth && this.device) {
      const signedAtMs = Date.now();
      const payload = this.buildDeviceAuthPayload({
        deviceId: this.device.deviceId,
        clientId,
        clientMode,
        role,
        scopes,
        signedAtMs,
        nonce: this.connectNonce,
        token: GATEWAY_TOKEN,
      });
      const signature = this.signData(payload);

      (connectReq.params as Record<string, unknown>).device = {
        id: this.device.deviceId,
        publicKey: this.device.publicKeyPem,
        signedAt: signedAtMs,
        nonce: this.connectNonce,
        signature,
      };
    }

    this.ws.send(JSON.stringify(connectReq));
  }

  private handleFrame(frame: unknown) {
    const f = frame as Record<string, unknown>;

    // 处理 connect.challenge (认证挑战)
    if (f.type === 'event' && f.event === 'connect.challenge') {
      const payload = f.payload as Record<string, unknown>;
      this.connectNonce = payload.nonce as string;
      console.log('[WS] 收到 challenge, nonce:', this.connectNonce?.slice(0, 8) + '...');
      // 如果有 device identity，使用 device auth；否则使用普通 auth
      this.sendConnect(!!this.device);
      return;
    }

    // 处理 connect 响应 (hello-ok)
    if (f.type === 'res') {
      const id = f.id as string;

      // 检查是否是 connect 响应
      const payload = f.payload as Record<string, unknown>;
      if (payload?.type === 'hello-ok') {
        console.log('[WS] 认证成功!');
        console.log(`  Server: ${(payload.server as Record<string, string>)?.version}`);
        console.log(`  ConnId: ${(payload.server as Record<string, string>)?.connId}`);
        console.log(`  可用方法: ${(payload.features as Record<string, string[]>)?.methods?.slice(0, 10).join(', ')}...`);
        this.connected = true;
        this.connectResolve?.();
        return;
      }

      // 其他响应
      console.log('[RES] 收到响应:', id, 'ok:', f.ok, 'error:', f.error || 'none');
      const resolve = this.pendingResolves.get(id);
      if (resolve) {
        resolve(f);
        this.pendingResolves.delete(id);
      }
      return;
    }

    // 处理错误
    if (f.type === 'error' || f.type === 'hello-err') {
      const error = f.error as Record<string, string>;
      console.error('[WS] 连接错误:', error?.code, error?.message);
      this.connectReject?.(new Error(`${error?.code}: ${error?.message}`));
      return;
    }

    // 处理事件
    if (f.type === 'event') {
      this.eventHandlers.forEach((h) => h(f));
      return;
    }

    console.log('[WS] 未知帧类型:', f.type);
  }

  async sendMessage(message: string): Promise<string> {
    if (!this.connected || !this.ws) {
      throw new Error('未连接');
    }

    const id = `req-${++this.reqId}`;
    const reqFrame = {
      type: 'req',
      id,
      method: 'agent',
      params: {
        message,
        sessionKey: this.sessionKey,
        idempotencyKey: uuidv4(),
        deliver: false,  // 不发送到 channel，只返回结果
      },
    };

    console.log(`\n[CHAT] 发送消息: "${message}"`);
    console.log(`       sessionKey: ${this.sessionKey}`);

    return new Promise((resolve) => {
      this.pendingResolves.set(id, resolve);
      this.ws!.send(JSON.stringify(reqFrame));
    });
  }

  onEvent(handler: (event: unknown) => void) {
    this.eventHandlers.push(handler);
  }

  close() {
    this.ws?.close();
  }
}

async function runTest(options: TestOptions) {
  console.log('=====================================');
  console.log('OpenClaw Gateway WebSocket 测试');
  console.log('=====================================\n');

  const client = new OpenClawWsClient(AGENT_ID, options.useDeviceIdentity !== false);
  const events: unknown[] = [];

  // 设置事件处理
  client.onEvent((event) => {
    const e = event as Record<string, unknown>;
    events.push(e);

    if (e.event === 'chat_event') {
      const payload = e.payload as Record<string, unknown>;
      const state = payload.state as string;
      const message = payload.message as Record<string, unknown>;

      if (state === 'delta') {
        // 流式输出
        const text = message?.text as string;
        if (text) {
          process.stdout.write(text);
        }
      } else if (state === 'final') {
        // 最终回复
        console.log('\n\n[CHAT] 回复完成');
        console.log(`       停止原因: ${payload.stopReason || 'N/A'}`);
      } else if (state === 'error') {
        console.error('\n[CHAT] 错误:', payload.errorMessage);
      }
    } else if (e.event === 'subagent_announce') {
      // Subagent 完成推送
      const payload = e.payload as Record<string, unknown>;
      console.log('\n\n[SUBAGENT] 收到子任务完成通知!');
      console.log(`           内容: ${payload.text}`);
      console.log(`           需要打断: ${payload.requireInterruption}`);
    } else {
      // 其他事件
      console.log('\n[EVENT]', e.event, JSON.stringify(e.payload, null, 2));
    }
  });

  try {
    // 1. 连接
    await client.connect();

    // 2. 发送消息
    const startTime = Date.now();
    const response = await client.sendMessage(options.message);
    console.log('[CHAT] 请求已发送,等待响应...');

    // 3. 等待一段时间接收事件
    await new Promise((resolve) => setTimeout(resolve, options.expectSubagent ? 30000 : 10000));

    const elapsed = Date.now() - startTime;
    console.log(`\n[TEST] 测试完成,耗时 ${elapsed}ms`);
    console.log(`       收到 ${events.length} 个事件`);

    // 统计事件类型
    const eventTypes = events.reduce((acc, e) => {
      const type = (e as Record<string, string>).event || 'unknown';
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log('       事件分布:', eventTypes);

    // 检查是否有 subagent 事件
    const hasSubagent = events.some((e) => (e as Record<string, string>).event === 'subagent_announce');
    if (hasSubagent) {
      console.log('       ✅ 检测到 subagent 完成推送!');
    } else if (options.expectSubagent) {
      console.log('       ⚠️ 预期有 subagent 推送但未收到');
    }
  } catch (err) {
    console.error('[TEST] 测试失败:', err);
  } finally {
    client.close();
  }
}

// 主函数
async function main() {
  const args = process.argv.slice(2);

  // 解析参数
  const useDeviceIdentity = !args.includes('--no-device');
  const testIndex = parseInt(args.find((a) => /^\d+$/.test(a)) || '0', 10);

  // 测试用例
  const testCases: TestCase[] = [
    {
      name: '简单对话',
      message: '你好，请简单介绍一下自己',
      expectSubagent: false,
    },
    {
      name: '可能触发 subagent 的任务',
      message: '帮我查一下最近有什么新闻',
      expectSubagent: true,
    },
    {
      name: '复杂任务',
      message: '分析一下当前项目代码，看看有没有可以优化的地方',
      expectSubagent: true,
    },
  ];

  // 选择测试
  const testCase = testCases[testIndex] || testCases[0];

  console.log(`\n测试用例 #${testIndex}: ${testCase.name}`);
  console.log(`消息: ${testCase.message}`);
  console.log(`预期 subagent: ${testCase.expectSubagent ? '是' : '否'}`);
  console.log(`使用 Device Identity: ${useDeviceIdentity ? '是' : '否 (scopes 会被清空)'}\n`);

  await runTest({ ...testCase, useDeviceIdentity });

  console.log('\n=====================================');
  console.log('测试结束');
  console.log('=====================================');
  console.log('\n可用测试用例:');
  testCases.forEach((tc, i) => {
    console.log(`  ${i}: ${tc.name}`);
  });
  console.log(`\n使用方法: npx tsx test-openclaw-ws.ts [0|1|2] [--no-device]`);
  console.log(`  --no-device: 不使用 Device Identity ( scopes 会被清空 )`);
}

interface TestCase {
  name: string;
  message: string;
  expectSubagent: boolean;
}

main().catch(console.error);
