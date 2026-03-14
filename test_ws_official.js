const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const appKey = '4441309548';
const accessKey = 'DgDP_QLeUnbRXv-d2FGeNXEuhyLgm4Om';
const voiceType = 'BV064_streaming';

// 判断 resource_id
function VoiceToResourceId(voice) {
  if (voice.startsWith('S_')) {
    return 'volc.megatts.default';
  }
  return 'volc.service_type.10029';
}

const resourceId = VoiceToResourceId(voiceType);

console.log('Resource ID:', resourceId);
console.log('Voice Type:', voiceType);

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

ws.on('open', () => {
  console.log('✅ Connected');
  
  // 发送 StartConnection
  const startConn = {
    event: 1, // StartConnection
    payload: '{}',
  };
  ws.send(JSON.stringify(startConn));
  console.log('📤 StartConnection sent');
});

ws.on('message', (data) => {
  console.log('📥 Received:', data.toString().substring(0, 200));
});

ws.on('error', (err) => console.error('❌ Error:', err.message));
ws.on('close', () => console.log('🔌 Closed'));

setTimeout(() => ws.close(), 5000);
