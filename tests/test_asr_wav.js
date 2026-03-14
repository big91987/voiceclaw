const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const appKey = '4441309548';
const accessKey = 'DgDP_QLeUnbRXv-d2FGeNXEuhyLgm4Om';
const resourceId = 'volc.bigasr.sauc.duration';

// 读取 WAV 音频文件
const audioFile = '/tmp/test_audio.wav';
const audioBuffer = fs.readFileSync(audioFile);

console.log('Testing ASR 2.0 with WAV format...');
console.log('Audio file:', audioFile);
console.log('Audio size:', audioBuffer.length, 'bytes');

const url = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';

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
let asrResults = [];
let audioSent = false;

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
  
  if (msgType === 0b1001) { // FullServerResponse
    const response = payload.toString();
    console.log('📥 Event', event, ':', response.substring(0, 200));
    
    if (event === 50) { // ConnectionStarted
      const startSessionPayload = JSON.stringify({
        user: { uid: uuidv4() },
        audio: {
          format: 'wav',
          rate: 16000,
          bits: 16,
          channel: 1,
          language: 'zh-CN',
          codec: 'raw'
        },
        request: {
          model_name: 'bigmodel'
        }
      });
      ws.send(createMessage(1, 4, 100, sessionId, Buffer.from(startSessionPayload)));
      console.log('📤 StartSession sent');
    } else if (event === 150) { // SessionStarted
      if (audioSent) return;
      audioSent = true;
      
      console.log('✅ Session started, sending audio...');
      // 跳过 WAV header (44 bytes)
      const wavHeaderSize = 44;
      const pcmData = audioBuffer.slice(wavHeaderSize);
      
      const chunkSize = 3200; // 100ms @ 16kHz 16bit
      let offset = 0;
      
      function sendNextChunk() {
        if (offset >= pcmData.length) {
          ws.send(createMessage(1, 4, 102, sessionId, Buffer.from('{}')));
          console.log('📤 FinishSession sent');
          return;
        }
        
        const chunk = pcmData.slice(offset, offset + chunkSize);
        ws.send(createMessage(2, 0, null, null, chunk));
        offset += chunkSize;
        
        setTimeout(sendNextChunk, 100);
      }
      
      sendNextChunk();
    } else if (event === 152) { // SessionFinished
      console.log('✅ Session finished');
      console.log('ASR Results:', asrResults);
      ws.send(createMessage(1, 4, 2, null, Buffer.from('{}')));
      setTimeout(() => ws.close(), 500);
    }
  } else if (msgType === 0b1011) { // AudioOnlyServer
    console.log('🎤 ASR result:', payload.toString().substring(0, 300));
    asrResults.push(payload.toString());
  } else if (msgType === 15) { // Error
    console.log('❌ Error:', payload.toString());
    ws.close();
  }
});

ws.on('error', (err) => console.error('❌ Error:', err.message));
ws.on('close', () => console.log('🔌 Closed'));

setTimeout(() => ws.close(), 30000);
