const WebSocket = require('ws');

const appid = '4441309548';
const accessKey = 'DgDP_QLeUnbRXv-d2FGeNXEuhyLgm4Om';
const resourceId = 'seed-tts-2.0';

const url = `wss://openspeech.bytedance.com/api/v3/tts/bidirection`;

console.log('Connecting...');

// 不指定子协议
const ws = new WebSocket(url, {
  headers: {
    'X-Api-App-Id': appid,
    'X-Api-Access-Key': accessKey,
    'X-Api-Resource-Id': resourceId,
  },
  perMessageDeflate: false,
});

ws.on('open', () => {
  console.log('✅ Connected');
  
  // 按照文档格式发送
  const request = {
    reqid: `req_${Date.now()}`,
    text: '你好',
    voice_type: 'BV700_V2_streaming',
    model: 'seed-tts-2.0-expressive',
  };
  
  const payload = JSON.stringify(request);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(Buffer.byteLength(payload), 0);
  
  ws.send(Buffer.concat([header, Buffer.from(payload)]));
  console.log('📤 Sent binary frame');
});

ws.on('message', (data) => {
  if (data instanceof Buffer) {
    console.log('📥 Binary received, length:', data.length);
    // 解析前4字节长度
    const len = data.readUInt32BE(0);
    const jsonStr = data.slice(4, 4 + len).toString();
    console.log('Response:', jsonStr.substring(0, 200));
  } else {
    console.log('📥 Text:', data.toString().substring(0, 200));
  }
});

ws.on('error', (err) => console.error('❌ Error:', err.message));
ws.on('close', () => console.log('🔌 Closed'));

setTimeout(() => ws.close(), 5000);
