const WebSocket = require('ws');

const appKey = '4441309548';
const accessKey = 'DgDP_QLeUnbRXv-d2FGeNXEuhyLgm4Om';
const resourceId = 'seed-tts-2.0';

// HTTP Chunked 接口
const url = `https://openspeech.bytedance.com/api/v3/tts/unidirectional`;

console.log('Testing HTTP with uranus_bigtts...');

// 先用 fetch 测试
fetch(url, {
  method: 'POST',
  headers: {
    'X-Api-App-Key': appKey,
    'X-Api-Access-Key': accessKey,
    'X-Api-Resource-Id': resourceId,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    reqid: `req_${Date.now()}`,
    text: '你好，这是豆包语音2.0测试',
    voice_type: 'zh_female_vv_uranus_bigtts',
  }),
}).then(async (res) => {
  console.log('Status:', res.status);
  const data = await res.text();
  console.log('Response:', data.substring(0, 200));
}).catch(err => {
  console.error('Error:', err.message);
});
