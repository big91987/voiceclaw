// 豆包 TTS 2.0 客户端（WebSocket 双向流式）
import WebSocket from 'ws';
import { config } from '../config';
import { TtsAudioCallback } from '../types';
import { v4 as uuidv4 } from 'uuid';

export class TtsClient {
  public onAudioChunk: TtsAudioCallback | null = null;
  public onSynthesisComplete: ((reqId: string) => void) | null = null;
  public onError: ((error: Error) => void) | null = null;

  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private ready = false;
  private readyResolve: (() => void) | null = null;
  private readyPromise: Promise<void> | null = null;
  private pendingQueue: { text: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  private currentJob: { text: string } | null = null;
  private cancelled = false;

  constructor() {
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    this.connect();
  }

  async waitForReady(): Promise<void> {
    return this.readyPromise || Promise.resolve();
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
      console.log('[TTS] WebSocket open');
      this.ws?.send(this.makeEvent(1, null, {}));
    });

    this.ws.on('message', (raw) => {
      const data = Buffer.from(raw as Buffer);
      const type = (data[1] >> 4) & 0x0f;
      const flag = data[1] & 0x0f;
      const payloadCompression = data[2] & 0x0f;

      let offset = 4;
      let event: number | null = null;

      if (type === 9) {
        event = data.readUInt32BE(offset);
        offset += 4;
      }

      const len = data.readUInt32BE(offset);
      offset += 4;
      let payload = data.slice(offset, offset + len);

      if (type === 9 && event === 50) {
        console.log('[TTS] server ready');
        this.ready = true;
        this.readyResolve?.();
        this.processQueue();
      } else if (type === 9 && event === 150) {
        console.log('[TTS] session ready');
        if (this.currentJob && !this.cancelled) {
          this.ws?.send(this.makeEvent(200, this.sessionId, {
            user: { uid: uuidv4() },
            req_params: {
              speaker: 'zh_female_vv_uranus_bigtts',
              text: this.currentJob.text,
              audio_params: { format: 'mp3', sample_rate: 24000 }
            },
          }));
          this.ws?.send(this.makeEvent(102, this.sessionId, {}));
        }
      } else if (type === 11 || (type === 9 && event === 352)) {
        console.log(`[TTS] audio chunk: ${payload.length} bytes`);
        this.onAudioChunk?.(payload, this.sessionId || 'unknown');
      } else if (type === 9 && event === 152) {
        console.log('[TTS] session finished');
        this.currentJob?.resolve();
        this.currentJob = null;
        this.processQueue();
      }
    });

    this.ws.on('error', (err) => {
      console.error('[TTS] WebSocket error:', err);
      this.currentJob?.reject(err as Error);
      this.currentJob = null;
      this.onError?.(err as Error);
    });

    this.ws.on('close', () => {
      console.log('[TTS] WebSocket closed, reconnecting...');
      this.ready = false;
      this.readyPromise = new Promise((resolve) => {
        this.readyResolve = resolve;
      });
      setTimeout(() => this.connect(), 1000);
    });
  }

  private makeEvent(type: number, sessionId: string | null, payload: object): Buffer {
    const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf-8');
    const header = Buffer.alloc(4);
    header[0] = (1 << 4) | 1;
    header[1] = ((type & 0x0f) << 4) | (sessionId ? 0b0001 : 0b0000);
    header[2] = (0 << 4) | 0;
    header[3] = 0;

    if (sessionId) {
      const sidBuf = Buffer.from(sessionId.replace(/-/g, ''), 'hex');
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(payloadBuf.length, 0);
      return Buffer.concat([header, sidBuf, lenBuf, payloadBuf]);
    } else {
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(payloadBuf.length, 0);
      return Buffer.concat([header, lenBuf, payloadBuf]);
    }
  }

  private processQueue() {
    if (!this.ready || this.currentJob || this.pendingQueue.length === 0) return;
    const job = this.pendingQueue.shift()!;
    console.log(`[TTS] starting synthesis: ${job.text.substring(0, 20)}`);
    this.cancelled = false;
    this.currentJob = { text: job.text, ...job };
    this.sessionId = uuidv4();
    this.ws?.send(this.makeEvent(100, this.sessionId, {
      user: { uid: uuidv4() },
      req_params: {
        speaker: 'zh_female_vv_uranus_bigtts',
        audio_params: { format: 'mp3', sample_rate: 24000 }
      },
    }));
  }

  async synthesize(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('TTS timeout'));
      }, 30000);

      this.pendingQueue.push({
        text,
        resolve: () => {
          clearTimeout(timeout);
          this.onSynthesisComplete?.(this.sessionId || 'unknown');
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(timeout);
          reject(e);
        }
      });

      this.processQueue();
    });
  }

  cancel(): void {
    console.log('[TTS] cancel');
    this.cancelled = true;
    if (this.currentJob) {
      this.currentJob.reject(new Error('Cancelled'));
      this.currentJob = null;
    }
    // 发送 finish
    if (this.ws?.readyState === WebSocket.OPEN && this.sessionId) {
      this.ws.send(this.makeEvent(102, this.sessionId, {}));
    }
  }

  async disconnect(): Promise<void> {
    this.ws?.close();
  }
}
