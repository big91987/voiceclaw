import WebSocket from 'ws';
import { gzipSync, gunzipSync } from 'zlib';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { AsrResultCallback } from '../types';

export class AsrClient {
  private ws: WebSocket | null = null;
  private started = false;
  private finished = false;
  private nextSeq = 2; // server first response uses seq=1

  public onPartialResult: AsrResultCallback | null = null;
  public onFinalResult: AsrResultCallback | null = null;

  private makeHeader(type: number, flag: number, serialization: number, compression: number): Buffer {
    const h = Buffer.alloc(4);
    h[0] = (1 << 4) | 1; // protocol version 1, header size 4 bytes
    h[1] = (type << 4) | flag;
    h[2] = (serialization << 4) | compression;
    h[3] = 0;
    return h;
  }

  private makeFullClientRequest(obj: object): Buffer {
    const gz = gzipSync(Buffer.from(JSON.stringify(obj)));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(gz.length, 0);
    return Buffer.concat([
      this.makeHeader(0b0001, 0b0000, 0b0001, 0b0001), // full request, json, gzip
      len,
      gz,
    ]);
  }

  private makeAudioPacket(chunk: Buffer, isLast = false): Buffer {
    const gz = gzipSync(chunk);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(gz.length, 0);

    if (isLast) {
      return Buffer.concat([
        this.makeHeader(0b0010, 0b0010, 0b0000, 0b0001), // audio only, last packet, raw, gzip
        len,
        gz,
      ]);
    }

    const seq = Buffer.alloc(4);
    seq.writeInt32BE(this.nextSeq++, 0);
    return Buffer.concat([
      this.makeHeader(0b0010, 0b0001, 0b0000, 0b0001), // audio only, positive seq, raw, gzip
      seq,
      len,
      gz,
    ]);
  }

  private parseMessage(data: Buffer): { type: number; flag: number; seq: number | null; errCode: number | null; payload: string } {
    const type = (data[1] >> 4) & 0x0f;
    const flag = data[1] & 0x0f;
    const compression = data[2] & 0x0f;

    let offset = 4;
    let seq: number | null = null;
    let errCode: number | null = null;

    if ([0b1001, 0b1011, 0b1100].includes(type) && [0b0001, 0b0010, 0b0011].includes(flag)) {
      seq = data.readInt32BE(offset);
      offset += 4;
    } else if (type === 0b1111) {
      errCode = data.readUInt32BE(offset);
      offset += 4;
    }

    const len = data.readUInt32BE(offset);
    offset += 4;
    let payload = data.slice(offset, offset + len);
    if (compression === 0b0001) {
      payload = gunzipSync(payload);
    }

    return { type, flag, seq, errCode, payload: payload.toString('utf8') };
  }

  startSession(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.closeSession();
    }

    this.started = false;
    this.finished = false;
    this.nextSeq = 2;

    this.ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel', {
      headers: {
        'X-Api-App-Key': config.asrAppId,
        'X-Api-Access-Key': config.asrApiKey,
        'X-Api-Resource-Id': 'volc.bigasr.sauc.duration',
        'X-Api-Connect-Id': uuidv4(),
      },
      skipUTF8Validation: true,
    });

    this.ws.on('open', () => {
      console.log('[ASR] WebSocket connected');
      const req = {
        user: { uid: uuidv4() },
        audio: {
          format: 'pcm',
          codec: 'raw',
          rate: 16000,
          bits: 16,
          channel: 1,
          language: 'zh-CN',
        },
        request: {
          model_name: 'bigmodel',
          enable_itn: true,
          enable_punc: true,
        },
      };
      this.ws?.send(this.makeFullClientRequest(req));
    });

    this.ws.on('message', (raw) => {
      const msg = this.parseMessage(Buffer.from(raw as Buffer));

      if (msg.type === 0b1111) {
        console.error('[ASR] error:', msg.payload);
        return;
      }

      if (msg.type === 0b1001) {
        try {
          const json = JSON.parse(msg.payload);
          const text = json?.result?.text || '';
          const utterances = json?.result?.utterances || [];
          const definite = utterances.some((u: any) => u?.definite === true);

          if (!this.started) {
            this.started = true;
            console.log('[ASR] session ready');
            return;
          }

          if (text) {
            if (definite || msg.flag === 0b0011) {
              this.onFinalResult?.(text, true);
            } else {
              this.onPartialResult?.(text, false);
            }
          }

          if (msg.flag === 0b0011) {
            this.finished = true;
            console.log('[ASR] final result:', text);
          }
        } catch {
          // ignore malformed JSON payloads
        }
      }
    });

    this.ws.on('error', (err) => {
      console.error('[ASR] WebSocket error:', err.message);
    });

    this.ws.on('close', () => {
      console.log('[ASR] WebSocket closed');
      this.started = false;
    });
  }

  sendAudio(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.started || this.finished) return;
    this.ws.send(this.makeAudioPacket(pcm, false));
  }

  finishAudio(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.started || this.finished) return;
    this.ws.send(this.makeAudioPacket(Buffer.alloc(0), true));
    console.log('[ASR] sent final audio packet');
  }

  closeSession(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.started = false;
    this.finished = false;
  }
}
