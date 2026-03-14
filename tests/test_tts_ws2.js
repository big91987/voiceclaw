const WebSocket = require('ws');

const appid = '4441309548';
const accessKey = 'DgDP_QLeUnbRXv-d2FGeNXEuhyLgm4Om';
const resourceId = 'seed-tts-2.0';

const url = `wss://openspeech.bytedance.com/api/v3/tts/bidirection`;

console.log('Connecting to:', url);

// 尝试不同的子协议
const ws = new WebSocket(url, ['tts', 'binary'], {
  headers: {
    'X-Api-App-Id': appid,
    'X-Api-Access-Key': accessKey,
    'X-Api-Resource-Id': resourceId,
  }
});

ws.on('open', () => {
  console.log('✅ WebSocket connected, protocol:', ws.protocol);
  
  const request = {
    reqid: `req_${Date.now()}`,
    text: '你好',
    voice_type: 'BV700_V2_streaming',
    model: 'seed-tts-2.0-expressive',
  };
  
  ws.send(JSON.stringify(request));
  console.log('📤 Sent:', request);
});

ws.on('message', (data) => {
  console.log('📥 Received:', data.toString().substring(0, 200));
});

ws.on('error', (err) => {
  console.error('❌ Error:', err.message);
});

ws.on('close', () => {
  console.log('🔌 Closed');
});

setTimeout(() => ws.close(), 5000);
