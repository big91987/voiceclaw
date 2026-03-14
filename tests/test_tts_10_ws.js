const WebSocket = require('ws');

const appKey = '4441309548';
const accessKey = 'DgDP_QLeUnbRXv-d2FGeNXEuhyLgm4Om';

// 试试 1.0 的 resource_id 和音色
const resourceId = 'seed-tts-1.0';
const voiceType = 'zh_female_cancan_mars_bigtts';

const url = `wss://openspeech.bytedance.com/api/v3/tts/bidirection`;

console.log('Testing with seed-tts-1.0...');

const ws = new WebSocket(url, {
  headers: {
    'X-Api-App-Key': appKey,
    'X-Api-Access-Key': accessKey,
    'X-Api-Resource-Id': resourceId,
  },
});

ws.on('open', () => {
  console.log('✅ Connected');
  
  const request = {
    reqid: `req_${Date.now()}`,
    text: '你好，测试WebSocket',
    voice_type: voiceType,
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
