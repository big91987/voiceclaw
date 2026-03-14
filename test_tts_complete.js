const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const appKey = '4441309548';
const accessKey = 'DgDP_QLeUnbRXv-d2FGeNXEuhyLgm4Om';
const voiceType = 'BV064_streaming';
const resourceId = voiceType.startsWith('S_') ? 'volc.megatts.default' : 'volc.service_type.10029';
const text = '你好，这是豆包语音合成测试';

console.log('Resource ID:', resourceId);
console.log('Voice Type:', voiceType);
console.log('Text:', text);

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

// 二进制协议封装
function createMessage(msgType, flag, event, sessionId, payload) {
  const headerSize = 4;
  const header = Buffer.alloc(headerSize);
  
  header[0] = (1 << 4) | 1;
  header[1] = (msgType << 4) | flag;
  header[2] = (1 << 4) | 0;
  header[3] = 0;
  
  let extra = Buffer.alloc(0);
  
  // WithEvent flag
  if (flag & 4) {
    const eventBytes = Buffer.alloc(4);
    eventBytes.writeInt32BE(event, 0);
    
    // Session ID (if not StartConnection/FinishConnection)
    let sessionIdBytes = Buffer.alloc(0);
    if (event >= 100 && sessionId) { // Session events
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
let state = 'connecting';

ws.on('open', () => {
  console.log('✅ Connected');
  
  // StartConnection
  const msg = createMessage(1, 4, 1, null, Buffer.from('{}'));
  ws.send(msg);
  state = 'starting_connection';
});

ws.on('message', (data) => {
  // 解析 header
  const msgType = (data[1] >> 4) & 0x0f;
  const flag = data[1] & 0x0f;
  
  let offset = 4;
  let event = null;
  
  if (flag & 4) {
    event = data.readInt32BE(offset);
    offset += 4;
    
    // Skip session ID if present
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
    console.log('🎵 Audio chunk received:', payload.length, 'bytes');
  } else if (msgType === 0b1001) { // FullServerResponse
    const response = payload.toString();
    console.log('📥 Event', event, ':', response.substring(0, 100));
    
    if (event === 50) { // ConnectionStarted
      // StartSession
      const startSessionPayload = JSON.stringify({
        user: { uid: uuidv4() },
        req_params: {
          speaker: voiceType,
          audio_params: { format: 'mp3', sample_rate: 24000 }
        }
      });
      const msg = createMessage(1, 4, 100, sessionId, Buffer.from(startSessionPayload));
      ws.send(msg);
      state = 'starting_session';
    } else if (event === 150) { // SessionStarted
      // Send text
      const taskPayload = JSON.stringify({
        user: { uid: uuidv4() },
        req_params: {
          speaker: voiceType,
          text: text,
          audio_params: { format: 'mp3', sample_rate: 24000 }
        }
      });
      const msg = createMessage(1, 4, 200, sessionId, Buffer.from(taskPayload));
      ws.send(msg);
      console.log('📤 Text sent');
      state = 'sending_text';
    } else if (event === 152) { // SessionFinished
      // FinishConnection
      const msg = createMessage(1, 4, 2, null, Buffer.from('{}'));
      ws.send(msg);
      state = 'finishing';
      
      // Save audio
      if (audioData.length > 0) {
        const audio = Buffer.concat(audioData);
        fs.writeFileSync('/tmp/test_tts_output.mp3', audio);
        console.log('✅ Audio saved to /tmp/test_tts_output.mp3, size:', audio.length);
      }
    }
  }
});

ws.on('error', (err) => console.error('❌ Error:', err.message));
ws.on('close', () => {
  console.log('🔌 Closed, state:', state);
  if (audioData.length === 0) {
    console.log('⚠️ No audio received');
  }
});

setTimeout(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
}, 10000);
