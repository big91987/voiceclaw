const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const zlib = require('zlib');

const appKey = '4441309548';
const accessKey = 'DgDP_QLeUnbRXv-d2FGeNXEuhyLgm4Om';
const resourceId = 'volc.bigasr.sauc.duration';
const audioFile = '/tmp/test_audio.wav';
const wav = fs.readFileSync(audioFile);
const pcm = wav.slice(44); // pcm_s16le 16k mono

const url = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';

function makeHeader({ version = 1, headerSize = 1, type, flag = 0, serialization = 1, compression = 0 }) {
  const h = Buffer.alloc(4);
  h[0] = (version << 4) | headerSize;
  h[1] = (type << 4) | flag;
  h[2] = (serialization << 4) | compression;
  h[3] = 0;
  return h;
}

function fullClientWithEvent(event, sessionId, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const parts = [makeHeader({ type: 1, flag: 4, serialization: 1, compression: 0 })];
  const eventBuf = Buffer.alloc(4); eventBuf.writeInt32BE(event, 0); parts.push(eventBuf);
  if (event >= 100 && sessionId) {
    const sid = Buffer.from(sessionId);
    const sidLen = Buffer.alloc(4); sidLen.writeUInt32BE(sid.length, 0);
    parts.push(sidLen, sid);
  }
  const len = Buffer.alloc(4); len.writeUInt32BE(payload.length, 0); parts.push(len, payload);
  return Buffer.concat(parts);
}

function audioOnly(seq, chunk, isLast = false) {
  const gz = zlib.gzipSync(chunk);
  const flag = isLast ? 0b10 : 0b01; // last / positive seq
  const parts = [makeHeader({ type: 0b10, flag, serialization: 0, compression: 0b1 })];
  const seqBuf = Buffer.alloc(4); seqBuf.writeInt32BE(seq, 0); parts.push(seqBuf);
  const len = Buffer.alloc(4); len.writeUInt32BE(gz.length, 0); parts.push(len, gz);
  return Buffer.concat(parts);
}

function parseMsg(data) {
  const type = (data[1] >> 4) & 0x0f;
  const flag = data[1] & 0x0f;
  const serialization = (data[2] >> 4) & 0x0f;
  const compression = data[2] & 0x0f;
  let offset = 4;
  let event = null, sessionId = null, seq = null;
  if (flag & 0b100) {
    event = data.readInt32BE(offset); offset += 4;
    if (![1,2,50,51,52].includes(event)) {
      const sidLen = data.readUInt32BE(offset); offset += 4;
      sessionId = data.slice(offset, offset + sidLen).toString(); offset += sidLen;
      if ([50,51,52].includes(event)) {
        const cidLen = data.readUInt32BE(offset); offset += 4 + cidLen;
      }
    } else if ([50,51,52].includes(event)) {
      const cidLen = data.readUInt32BE(offset); offset += 4;
      const cid = data.slice(offset, offset + cidLen).toString(); offset += cidLen;
    }
  }
  if ([1,2,4,9,11,12].includes(type) && (flag === 1 || flag === 2 || flag === 3)) {
    seq = data.readInt32BE(offset); offset += 4;
  }
  const len = data.readUInt32BE(offset); offset += 4;
  let payload = data.slice(offset, offset + len);
  if (compression === 1) payload = zlib.gunzipSync(payload);
  return { type, flag, event, sessionId, seq, payload: payload.toString('utf8'), raw: payload };
}

console.log('ASR gzip test start');
const ws = new WebSocket(url, {
  headers: {
    'X-Api-App-Key': appKey,
    'X-Api-Access-Key': accessKey,
    'X-Api-Resource-Id': resourceId,
    'X-Api-Connect-Id': uuidv4(),
  },
  skipUTF8Validation: true,
});

const sessionId = uuidv4();
let sent = false;
let results = [];

ws.on('open', () => {
  console.log('connected');
  ws.send(fullClientWithEvent(1, null, {}));
});

ws.on('message', (buf) => {
  const m = parseMsg(Buffer.from(buf));
  console.log('recv', { type: m.type, flag: m.flag, event: m.event, seq: m.seq, payload: m.payload.slice(0,120) });
  if (m.type === 15) {
    console.log('ERROR', m.payload);
    ws.close();
    return;
  }
  if (m.event === 50) {
    ws.send(fullClientWithEvent(100, sessionId, {
      user: { uid: uuidv4() },
      audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1, language: 'zh-CN' },
      request: { model_name: 'bigmodel', enable_punc: true, enable_itn: true }
    }));
  } else if (m.event === 150 && !sent) {
    sent = true;
    const chunkSize = 6400; // 200ms
    let seq = 1;
    for (let off = 0; off < pcm.length; off += chunkSize) {
      const chunk = pcm.slice(off, off + chunkSize);
      const isLast = off + chunkSize >= pcm.length;
      ws.send(audioOnly(isLast ? -seq : seq, chunk, isLast));
      seq++;
    }
    console.log('audio sent');
  } else if (m.type === 9 && (m.event === 451 || m.event === 154 || m.event === 152)) {
    results.push(m.payload);
    if (m.event === 152) {
      console.log('FINAL_RESULTS', results);
      ws.send(fullClientWithEvent(2, null, {}));
      setTimeout(() => ws.close(), 500);
    }
  }
});

ws.on('close', () => console.log('closed'));
ws.on('error', (e) => console.error('ws error', e.message));
setTimeout(() => ws.close(), 30000);
