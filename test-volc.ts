// 测试火山云 ASR + TTS
import { config } from './src/config';

async function testTTS() {
  console.log('🎙️ 测试 TTS...');
  
  // 使用方舟平台 API 端点
  const url = 'https://ark.cn-beijing.volces.com/api/v3/tts';
  const requestBody = {
    app: {
      appid: config.ttsAppId,
      token: config.ttsApiKey,
    },
    request: {
      request_id: `test_${Date.now()}`,
      text: '你好，我是豆包语音合成测试。',
      voice_type: config.ttsVoiceType || 'BV700_V2_streaming',
      encoding: 'wav',
      sample_rate: 24000,
      speed_ratio: 1.0,
      volume_ratio: 1.0,
      pitch_ratio: 1.0,
      codec: 'raw',
    },
  };
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.ttsApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ TTS 失败:', response.status, errorText);
      return false;
    }
    
    const arrayBuffer = await response.arrayBuffer();
    console.log('✅ TTS 成功，音频大小:', arrayBuffer.byteLength, 'bytes');
    
    // 保存测试音频
    const fs = await import('fs');
    fs.writeFileSync('/tmp/test_tts.wav', Buffer.from(arrayBuffer));
    console.log('💾 音频已保存到 /tmp/test_tts.wav');
    return true;
    
  } catch (e: any) {
    console.error('❌ TTS 错误:', e.message);
    return false;
  }
}

async function testASR() {
  console.log('\n🎤 测试 ASR WebSocket 连接...');
  
  const WebSocket = (await import('ws')).default;
  
  return new Promise((resolve) => {
    const url = `wss://openspeech.bytedance.com/api/v2/asr?appid=${config.asrAppId}&token=${config.asrApiKey}`;
    
    const ws = new WebSocket(url, {
      headers: { 'Authorization': `Bearer ${config.asrApiKey}` },
    });
    
    ws.on('open', () => {
      console.log('✅ ASR WebSocket 连接成功');
      
      // 发送开始识别请求
      const startReq = {
        event: 'StartRecognition',
        app: { appid: config.asrAppId, token: config.asrApiKey },
        format: 'pcm',
        sample_rate: 16000,
        bits: 16,
        channel: 1,
        codec: 'raw',
        language: 'zh-CN',
      };
      ws.send(JSON.stringify(startReq));
      console.log('📤 发送开始识别请求');
    });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log('📥 ASR 响应:', msg.event, msg.result || '');
        
        if (msg.event === 'StartRecognition') {
          console.log('✅ ASR 会话启动成功');
          ws.close();
          resolve(true);
        }
      } catch (e) {
        console.log('📥 收到非 JSON 数据');
      }
    });
    
    ws.on('error', (err: any) => {
      console.error('❌ ASR WebSocket 错误:', err.message);
      resolve(false);
    });
    
    ws.on('close', () => {
      console.log('🔌 ASR WebSocket 关闭');
    });
    
    // 5秒超时
    setTimeout(() => {
      console.log('⏱️ ASR 测试超时');
      ws.close();
      resolve(false);
    }, 5000);
  });
}

async function main() {
  console.log('='.repeat(50));
  console.log('🔥 火山云 ASR/TTS 测试');
  console.log('='.repeat(50));
  console.log('AppID:', config.ttsAppId);
  console.log('Voice:', config.ttsVoiceType);
  console.log('');
  
  // 测试 TTS
  const ttsOk = await testTTS();
  
  // 测试 ASR
  const asrOk = await testASR();
  
  console.log('\n' + '='.repeat(50));
  console.log('📊 测试结果:');
  console.log('  TTS:', ttsOk ? '✅ 通过' : '❌ 失败');
  console.log('  ASR:', asrOk ? '✅ 通过' : '❌ 失败');
  console.log('='.repeat(50));
  
  process.exit(ttsOk && asrOk ? 0 : 1);
}

main();
