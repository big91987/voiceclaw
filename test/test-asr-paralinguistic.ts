/**
 * 测试火山 BigModel ASR 副语言特征（情感/性别/语速/音量）
 *
 * 用法：
 *   npx ts-node test/test-asr-paralinguistic.ts [audio.wav]
 *
 * 若不传文件，脚本会从麦克风录音 5 秒（需要 node-record-lpcm16）。
 * 若传 WAV 文件，须为 PCM 16kHz 16bit mono（可用 ffmpeg 转换）。
 *
 * 副语言特征仅在 definite:true 的 utterance 中返回，通过 enable_nonstream:true 开启二遍识别。
 */

import WebSocket from 'ws';
import { gzipSync, gunzipSync } from 'zlib';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: resolve(__dirname, '../.env') });

const ASR_APP_ID = process.env.ASR_APP_ID || '';
const ASR_API_KEY = process.env.ASR_API_KEY || '';

if (!ASR_APP_ID || !ASR_API_KEY) {
  console.error('❌ 缺少 ASR_APP_ID 或 ASR_API_KEY，请检查 .env 文件');
  process.exit(1);
}

// ─── Binary protocol helpers ──────────────────────────────────────────────────

function makeHeader(type: number, flag: number, serial: number, compress: number): Buffer {
  const h = Buffer.alloc(4);
  h[0] = (1 << 4) | 1;            // protocol version=1, header size=4
  h[1] = (type << 4) | flag;
  h[2] = (serial << 4) | compress;
  h[3] = 0;
  return h;
}

function makeFullClientRequest(obj: object): Buffer {
  const gz = gzipSync(Buffer.from(JSON.stringify(obj)));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(gz.length, 0);
  return Buffer.concat([
    makeHeader(0b0001, 0b0000, 0b0001, 0b0001), // full request, no-seq, json, gzip
    len,
    gz,
  ]);
}

let nextSeq = 2;
function makeAudioPacket(chunk: Buffer, isLast: boolean): Buffer {
  const gz = gzipSync(chunk);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(gz.length, 0);
  if (isLast) {
    return Buffer.concat([
      makeHeader(0b0010, 0b0010, 0b0000, 0b0001), // audio, last-packet, raw, gzip
      len,
      gz,
    ]);
  }
  const seq = Buffer.alloc(4);
  seq.writeInt32BE(nextSeq++, 0);
  return Buffer.concat([
    makeHeader(0b0010, 0b0001, 0b0000, 0b0001), // audio, positive-seq, raw, gzip
    seq,
    len,
    gz,
  ]);
}

function parseMessage(data: Buffer): { type: number; flag: number; errCode: number | null; payload: string } {
  const type = (data[1] >> 4) & 0x0f;
  const flag = data[1] & 0x0f;
  const compression = data[2] & 0x0f;

  let offset = 4;
  let errCode: number | null = null;

  if ([0b1001, 0b1011, 0b1100].includes(type) && [0b0001, 0b0010, 0b0011].includes(flag)) {
    offset += 4; // skip sequence number
  } else if (type === 0b1111) {
    errCode = data.readUInt32BE(offset);
    offset += 4;
  }

  const payloadLen = data.readUInt32BE(offset);
  offset += 4;
  let payload = data.slice(offset, offset + payloadLen);
  if (compression === 0b0001) {
    payload = gunzipSync(payload);
  }
  return { type, flag, errCode, payload: payload.toString('utf8') };
}

// ─── Read PCM from WAV file ────────────────────────────────────────────────────

function readPcmFromWav(filePath: string): Buffer {
  const buf = readFileSync(filePath);
  // Skip WAV header (44 bytes for standard PCM WAV)
  // Validate RIFF header
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') {
    const dataIdx = buf.indexOf('data', 36);
    if (dataIdx !== -1) {
      return buf.slice(dataIdx + 8); // skip 'data' + size (4 bytes)
    }
    return buf.slice(44);
  }
  // Assume raw PCM
  return buf;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runTest(pcmData: Buffer): Promise<void> {
  const CHUNK_SIZE = 3200; // 100ms @ 16kHz 16bit mono = 3200 bytes

  return new Promise((resolve, reject) => {
    // bigmodel_async = 双向流式优化版，enable_nonstream/情感/性别/语速/音量仅此端点支持
    const ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async', {
      headers: {
        'X-Api-App-Key': ASR_APP_ID,
        'X-Api-Access-Key': ASR_API_KEY,
        'X-Api-Resource-Id': 'volc.bigasr.sauc.duration',
        'X-Api-Connect-Id': uuidv4(),
      },
      skipUTF8Validation: true,
    });

    let sessionReady = false;
    let done = false;

    ws.on('open', () => {
      console.log('[ASR] 已连接，发送初始化请求（副语言特征全开）...\n');

      const req = {
        user: { uid: uuidv4() },
        audio: {
          format: 'pcm',
          codec: 'raw',
          rate: 16000,
          bits: 16,
          channel: 1,
          // language 参数在 bigmodel_async 模式下不支持，不传
        },
        request: {
          model_name: 'bigmodel',
          enable_itn: true,
          enable_punc: true,
          result_mode: 'utterance',
          enable_nonstream: true,          // 二遍识别，副语言特征需此模式
          enable_emotion_detection: true,  // 情感：angry/happy/neutral/sad/surprise
          enable_gender_detection: true,   // 性别：male/female
          show_speech_rate: true,          // 语速（tokens/s）
          show_volume: true,               // 音量（dB）
        },
      };
      ws.send(makeFullClientRequest(req));
    });

    ws.on('message', (raw: Buffer) => {
      const msg = parseMessage(Buffer.from(raw));

      if (msg.type === 0b1111) {
        console.error('[ASR] 错误响应:', msg.payload);
        ws.close();
        reject(new Error(`ASR error: ${msg.payload}`));
        return;
      }

      if (msg.type !== 0b1001) return;

      let json: any;
      try { json = JSON.parse(msg.payload); } catch { return; }

      if (!sessionReady) {
        sessionReady = true;
        console.log('[ASR] Session ready，开始发送音频...\n');
        sendAudio();
        return;
      }

      // Print every response for inspection
      const result = json?.result;
      if (!result) return;

      const text = result?.text || '';
      const utterances: any[] = result?.utterances || [];
      const isDefinite = utterances.some((u: any) => u?.definite === true);
      const isLast = msg.flag === 0b0011;

      console.log('─'.repeat(60));
      console.log(`[ASR] ${isDefinite ? '🎯 DEFINITE' : '📝 partial'} ${isLast ? '(LAST)' : ''}`);
      console.log(`  text: "${text}"`);

      if (utterances.length > 0) {
        utterances.forEach((u: any, i: number) => {
          console.log(`  utterance[${i}]:`, JSON.stringify({
            text: u.text,
            definite: u.definite,
            start_time: u.start_time,
            end_time: u.end_time,
            additions: u.additions || null,  // 副语言特征在这里
          }, null, 2).replace(/\n/g, '\n    '));
        });
      }

      if (isLast && !done) {
        done = true;
        console.log('\n✅ ASR 识别完成');
        ws.close();
        resolve();
      }
    });

    ws.on('error', (err) => {
      console.error('[ASR] WebSocket error:', err.message);
      reject(err);
    });

    ws.on('close', () => {
      if (!done) {
        resolve(); // closed before last flag
      }
    });

    function sendAudio() {
      let offset = 0;
      const interval = setInterval(() => {
        if (!sessionReady || ws.readyState !== WebSocket.OPEN) {
          clearInterval(interval);
          return;
        }
        const end = Math.min(offset + CHUNK_SIZE, pcmData.length);
        const chunk = pcmData.slice(offset, end);
        const isLast = end >= pcmData.length;

        if (chunk.length > 0) {
          ws.send(makeAudioPacket(chunk, isLast));
        }

        offset = end;
        if (isLast) {
          clearInterval(interval);
          console.log('[ASR] 音频发送完毕，等待最终结果...\n');
        }
      }, 100); // 每 100ms 发一帧（与实时录音速率一致）
    }
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const wavFile = process.argv[2];

  let pcmData: Buffer;

  if (wavFile) {
    const absPath = resolve(wavFile);
    if (!existsSync(absPath)) {
      console.error(`❌ 文件不存在: ${absPath}`);
      process.exit(1);
    }
    console.log(`📁 读取音频文件: ${absPath}`);
    pcmData = readPcmFromWav(absPath);
    console.log(`   PCM 数据大小: ${pcmData.length} bytes (约 ${(pcmData.length / 32000).toFixed(1)}s @ 16kHz)\n`);
  } else {
    // 生成 3 秒静音 PCM 作为 fallback（用于验证连接，不会有副语言结果）
    console.log('⚠️  未传入音频文件，使用 3 秒静音 PCM（仅验证连接）');
    console.log('   传入真实语音文件以测试副语言特征：\n');
    console.log('   npx ts-node test/test-asr-paralinguistic.ts path/to/audio.wav\n');
    console.log('   WAV 格式要求：PCM 16kHz 16bit mono');
    console.log('   ffmpeg 转换命令：ffmpeg -i input.mp3 -ar 16000 -ac 1 -f s16le output.pcm\n');
    pcmData = Buffer.alloc(3 * 32000); // 3s silence
  }

  try {
    await runTest(pcmData);
  } catch (err: any) {
    console.error('❌ 测试失败:', err.message);
    process.exit(1);
  }
}

main();
