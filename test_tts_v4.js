const WebSocket = require('ws');

const appKey = '4441309548';
const accessKey = 'DgDP_QLeUnbRXv-d2FGeNXEuhyLgm4Om';
const resourceId = 'seed-tts-2.0';

const url = `wss://openspeech.bytedance.com/api/v3/tts/bidirection`;

console.log('Connecting...');

const ws = new WebSocket(url, {
  headers: {
    'X-Api-App-Key': appKey,
    'X-Api-Access-Key': accessKey,
    'X-Api-Resource-Id': resourceId,
  },
});

ws.on('open', () => {
  console.log('✅ Connected');
  
  // 添加 protocol_version 参数
  const request = {
    reqid: `req_${Date.now()}`,
    text: '你好',
    voice_type: 'BV700_V2_streaming',
    model: 'seed-tts-2.0-expressive',
    protocol_version: 'v3',  // 尝试添加协议版本
  };
  
  ws.send(JSON.stringify(request));
  console.log('📤 Sent:', request);
});

ws.on('message', (data) => {
  console.log('📥 Received:', data.toString().substring(0, 300));
});

ws.on('error', (err) => console.error('❌ Error:', err.message));
ws.on('close', () => console.log('🔌 Closed'));

setTimeout(() => ws.close(), 5000);
