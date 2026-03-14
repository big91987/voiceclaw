const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const appKey = '4441309548';
const accessKey = 'DgDP_QLeUnbRXv-d2FGeNXEuhyLgm4Om';
const voiceType = 'zh_female_vv_uranus_bigtts';
const resourceId = 'seed-tts-2.0';
const text = '你好，这是豆包语音2.0测试';

console.log('Voice Type:', voiceType);
console.log('Resource ID:', resourceId);

const url = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';

const ws = new WebSocket(url, {
  headers: {
    'X-Api-App-Key': appKey,
    'X-Api-Access-Key': accessKey,
    'X-Api-Resource-Id': resourceId,
    'X-Api-Connect-Id': uuidv4(),
  },
  skipUTF8Validation: true,
});

function createMessage(msgType, flag, event, sessionId, payload) {
  const header = Buffer.alloc(4);
  header[0] = (1 << 4) | 1;
  header[1] = (msgType << 4) | flag;
  header[2] = (1 << 4) | 0;
  header[3] = 0;
  
  let extra = Buffer.alloc(0);
  if (flag & 4) {
    const eventBytes = Buffer.alloc(4);
    eventBytes.writeInt32BE(event, 0);
    let sessionIdBytes = Buffer.alloc(0);
    if (event >= 100 && sessionId) {
      const sidBytes = Buffer.from(sessionId, 'utf8');
      const sidLen = Buffer.alloc(4);
      sidLen.writeUInt32BE(sidBytes.length, 0);
      sessionIdBytes = Buffer.concat([sidLen, sidBytes]);
    }
    extra = Buffer.concat([eventBytes, sessionIdBytes]);
  }
  
  const payloadLen = Buffer.alloc(4);
  payloadLen.writeUInt32BE(payload.length, 0);
  
  return Buffer.concat([header, extra, payloadLen, payload]);
}

let sessionId = uuidv4();
let audioData = [];

ws.on('open', () => {
  console.log('✅ Connected');
  ws.send(createMessage(1, 4, 1, null, Buffer.from('{}')));
});

ws.on('message', (data) => {
  const msgType = (data[1] >> 4) & 0x0f;
  const flag = data[1] & 0x0f;
  
  let offset = 4;
  let event = null;
  
  if (flag & 4) {
    event = data.readInt32BE(offset);
    offset += 4;
    if (event >= 100) {
      const sidLen = data.readUInt32BE(offset);
      offset += 4 + sidLen;
    }
  }
  
  const payloadLen = data.readUInt32BE(offset);
  offset += 4;
  const payload = data.slice(offset, offset + payloadLen);
  
  if (msgType === 0b1011) { // AudioOnlyServer
    audioData.push(payload);
    console.log('🎵 Audio chunk:', payload.length, 'bytes');
  } else if (msgType === 0b1001) { // FullServerResponse
    console.log('📥 Event', event, ':', payload.toString().substring(0, 100));
    
    if (event === 50) { // ConnectionStarted
      const startSessionPayload = JSON.stringify({
        user: { uid: uuidv4() },
        req_params: {
          speaker: voiceType,
          audio_params: { format: 'mp3', sample_rate: 24000 }
        }
      });
      ws.send(createMessage(1, 4, 100, sessionId, Buffer.from(startSessionPayload)));
      console.log('📤 StartSession sent');
    } else if (event === 150) { // SessionStarted
      const taskPayload = JSON.stringify({
        user: { uid: uuidv4() },
        req_params: {
          speaker: voiceType,
          text: text,
          audio_params: { format: 'mp3', sample_rate: 24000 }
        }
      });
      ws.send(createMessage(1, 4, 200, sessionId, Buffer.from(taskPayload)));
      console.log('📤 TaskRequest sent');
    } else if (event === 152) { // SessionFinished
      console.log('✅ Session finished');
      if (audioData.length > 0) {
        const audio = Buffer.concat(audioData);
        fs.writeFileSync('/tmp/test_tts_20_output.mp3', audio);
        console.log('✅ Audio saved:', audio.length, 'bytes');
      }
      ws.send(createMessage(1, 4, 2, null, Buffer.from('{}')));
      setTimeout(() => ws.close(), 500);
    }
  } else if (msgType === 15) { // Error
    console.log('❌ Error:', payload.toString());
    ws.close();
  }
});

ws.on('error', (err) => console.error('❌ Error:', err.message));
ws.on('close', () => console.log('🔌 Closed'));

setTimeout(() => ws.close(), 15000);
