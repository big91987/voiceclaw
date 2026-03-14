const WebSocket = require('ws');

const appKey = '4441309548';  // X-Api-App-Key
const accessKey = 'DgDP_QLeUnbRXv-d2FGeNXEuhyLgm4Om';
const resourceId = 'seed-tts-2.0';

const url = `wss://openspeech.bytedance.com/api/v3/tts/bidirection`;

console.log('Connecting with corrected headers...');

const ws = new WebSocket(url, {
  headers: {
    'X-Api-App-Key': appKey,        // 修正：App-Key 不是 App-Id
    'X-Api-Access-Key': accessKey,
    'X-Api-Resource-Id': resourceId,
  },
});

ws.on('open', () => {
  console.log('✅ Connected');
  
  const request = {
    reqid: `req_${Date.now()}`,
    text: '你好，这是豆包语音2.0测试',
    voice_type: 'BV700_V2_streaming',
    model: 'seed-tts-2.0-expressive',
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
