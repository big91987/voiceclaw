const WebSocket = require('ws');

const appid = '4441309548';
const accessKey = 'DgDP_QLeUnbRXv-d2FGeNXEuhyLgm4Om';
const resourceId = 'seed-tts-2.0';

const url = `wss://openspeech.bytedance.com/api/v3/tts/bidirection`;

console.log('Connecting to:', url);

const ws = new WebSocket(url, {
  headers: {
    'X-Api-App-Id': appid,
    'X-Api-Access-Key': accessKey,
    'X-Api-Resource-Id': resourceId,
  }
});

ws.on('open', () => {
  console.log('✅ WebSocket connected');
  
  // 发送合成请求
  const request = {
    reqid: `req_${Date.now()}`,
    text: '你好，这是豆包语音2.0测试',
    voice_type: 'BV700_V2_streaming',
    model: 'seed-tts-2.0-expressive',
  };
  
  ws.send(JSON.stringify(request));
  console.log('📤 Sent request:', request);
});

ws.on('message', (data) => {
  console.log('📥 Received:', data.toString().substring(0, 200));
});

ws.on('error', (err) => {
  console.error('❌ Error:', err.message);
});

ws.on('close', () => {
  console.log('🔌 Connection closed');
});

// 5秒后关闭
setTimeout(() => {
  ws.close();
}, 5000);
