const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const zlib = require('zlib');

const appKey = '4441309548';
const accessKey = 'DgDP_QLeUnbRXv-d2FGeNXEuhyLgm4Om';
const resourceId = 'volc.bigasr.sauc.duration';
const pcm = fs.readFileSync('/tmp/test_audio.wav').slice(44);

function header(type, flag, serialization, compression) {
  const h = Buffer.alloc(4);
  h[0] = (1 << 4) | 1;
  h[1] = (type << 4) | flag;
  h[2] = (serialization << 4) | compression;
  h[3] = 0;
  return h;
}
function fullClientRequest(jsonObj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(jsonObj)));
  const len = Buffer.alloc(4); len.writeUInt32BE(gz.length, 0);
  return Buffer.concat([header(1,0,1,1), len, gz]);
}
function audioOnly(seq, bytes, isLast = false) {
  const gz = zlib.gzipSync(bytes);
  const seqBuf = Buffer.alloc(4); seqBuf.writeInt32BE(seq, 0);
  const len = Buffer.alloc(4); len.writeUInt32BE(gz.length, 0);
  return Buffer.concat([
    header(2, isLast ? 2 : 1, 0, 1),
    seqBuf,
    len,
    gz,
  ]);
}
function parse(buf) {
  const type = (buf[1] >> 4) & 0x0f;
  const flag = buf[1] & 0x0f;
  const compression = buf[2] & 0x0f;
  let offset = 4, seq = null, errCode = null;
  if ([9,11,12].includes(type) && [1,2,3].includes(flag)) { seq = buf.readInt32BE(offset); offset += 4; }
  else if (type === 15) { errCode = buf.readUInt32BE(offset); offset += 4; }
  const len = buf.readUInt32BE(offset); offset += 4;
  let payload = buf.slice(offset, offset + len);
  if (compression === 1) payload = zlib.gunzipSync(payload);
  return { type, flag, seq, errCode, payload: payload.toString('utf8') };
}

console.log('ASR real flow v2');
const ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel', {
  headers: {
    'X-Api-App-Key': appKey,
    'X-Api-Access-Key': accessKey,
    'X-Api-Resource-Id': resourceId,
    'X-Api-Connect-Id': uuidv4(),
  },
  skipUTF8Validation: true,
});
let sent = false;
let results = [];
ws.on('open', () => {
  ws.send(fullClientRequest({
    user: { uid: uuidv4() },
    audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1, language: 'zh-CN' },
    request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true }
  }));
  console.log('full request sent');
});
ws.on('message', (data) => {
  const m = parse(Buffer.from(data));
  console.log('recv', m);
  if (m.type === 15) { ws.close(); return; }
  if (m.type === 9 && !sent) {
    sent = true;
    const chunkSize = 6400;
    let seq = 2;
    for (let off = 0; off < pcm.length; off += chunkSize) {
      const isLast = off + chunkSize >= pcm.length;
      ws.send(audioOnly(seq, pcm.slice(off, off + chunkSize), isLast));
      seq += 1;
    }
    console.log('audio sent');
  } else if (m.type === 9) {
    results.push(m.payload);
    if (m.flag === 3) {
      console.log('FINAL', results);
      ws.close();
    }
  }
});
ws.on('close', ()=>console.log('closed'));
ws.on('error', e=>console.error('ws error', e.message));
setTimeout(()=>ws.close(),30000);
