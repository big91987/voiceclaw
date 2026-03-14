const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const appKey = '4441309548';
const accessKey = 'DgDP_QLeUnbRXv-d2FGeNXEuhyLgm4Om';
const voiceType = 'BV064_streaming';
const resourceId = voiceType.startsWith('S_') ? 'volc.megatts.default' : 'volc.service_type.10029';

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

// 二进制协议封装
function createMessage(msgType, flag, event, payload) {
  const headerSize = 4;
  const header = Buffer.alloc(headerSize);
  
  // version (4 bits) + headerSize (4 bits)
  header[0] = (1 << 4) | 1; // Version 1, HeaderSize 1 (4 bytes)
  // msgType (4 bits) + flag (4 bits)
  header[1] = (msgType << 4) | flag;
  // serialization (4 bits) + compression (4 bits)
  header[2] = (1 << 4) | 0; // JSON, No compression
  header[3] = 0; // Reserved
  
  const eventBytes = event ? Buffer.alloc(4) : Buffer.alloc(0);
  if (event) eventBytes.writeInt32BE(event, 0);
  
  const payloadLen = Buffer.alloc(4);
  payloadLen.writeUInt32BE(payload.length, 0);
  
  return Buffer.concat([header, eventBytes, payloadLen, payload]);
}

ws.on('open', () => {
  console.log('✅ Connected');
  
  // StartConnection: msgType=1 (FullClientRequest), flag=4 (WithEvent), event=1
  const msg = createMessage(1, 4, 1, Buffer.from('{}'));
  ws.send(msg);
  console.log('📤 Binary StartConnection sent');
});

ws.on('message', (data) => {
  console.log('📥 Raw data length:', data.length);
  // 解析响应
  if (data.length > 4) {
    const payloadLen = data.readUInt32BE(4);
    const payload = data.slice(8, 8 + payloadLen);
    console.log('📥 Response:', payload.toString().substring(0, 200));
  }
});

ws.on('error', (err) => console.error('❌ Error:', err.message));
ws.on('close', () => console.log('🔌 Closed'));

setTimeout(() => ws.close(), 5000);
