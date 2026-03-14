const WebSocket = require('ws');

const appKey = '4441309548';
const accessKey = 'DgDP_QLeUnbRXv-d2FGeNXEuhyLgm4Om';
const resourceId = 'seed-tts-2.0';

const url = `wss://openspeech.bytedance.com/api/v3/tts/bidirection`;

console.log('Testing with custom origin...');

const ws = new WebSocket(url, {
  headers: {
    'X-Api-App-Key': appKey,
    'X-Api-Access-Key': accessKey,
    'X-Api-Resource-Id': resourceId,
    'Origin': 'https://console.volcengine.com',
  },
  origin: 'https://console.volcengine.com',
});

ws.on('open', () => {
  console.log('✅ Connected, protocol:', ws.protocol);
  console.log('Extensions:', ws.extensions);
  
  const request = {
    reqid: `req_${Date.now()}`,
    text: '你好',
    voice_type: 'zh_female_shuangkuaisisi_moon_bigtts',
    model: 'seed-tts-2.0-expressive',
  };
  
  ws.send(JSON.stringify(request));
  console.log('📤 Sent:', request);
});

ws.on('message', (data) => {
  console.log('📥 Received:', data.toString().substring(0, 300));
});

ws.on('error', (err) => console.error('❌ Error:', err.message));
ws.on('close', (code, reason) => console.log('🔌 Closed:', code, reason));

setTimeout(() => ws.close(), 5000);
