// VoiceClaw 主入口 - 组装所有模块
import { config, validateConfig } from './config';
import { RtcClient } from './rtc/RtcClient';
import { AsrClient } from './asr/AsrClient';
import { TtsClient } from './tts/TtsClient';
import { GatewayClient } from './gateway/GatewayClient';
import { MockGateway } from './gateway/MockGateway';
import { SentenceBuffer } from './pipeline/SentenceBuffer';
import { InterruptManager } from './pipeline/InterruptManager';
import { v4 as uuidv4 } from 'uuid';

async function main() {
  console.log('='.repeat(50));
  console.log('🎙️ VoiceClaw 主控服务启动');
  console.log('='.repeat(50));
  
  // 1. 验证配置
  if (!validateConfig()) {
    console.error('❌ 配置验证失败，请检查 .env 文件');
    process.exit(1);
  }
  
  // 2. 启动 MockGateway（阶段一）
  let gatewayClient: GatewayClient;
  
  if (config.useMockGateway) {
    console.log('[阶段一] 使用 Mock Gateway');
    const mockGateway = new MockGateway();
    await mockGateway.start();
    
    gatewayClient = new GatewayClient(
      `http://localhost:${config.mockGatewayPort}`,
      'mock-token',
      'mock-model'
    );
  } else {
    console.log('[阶段二] 使用真实龙虾 Gateway');
    gatewayClient = new GatewayClient();
  }
  
  // 3. 初始化 TTS 客户端
  console.log('[TTS] 初始化...');
  const ttsClient = new TtsClient();
  try {
    await ttsClient.waitForReady();
    console.log('[TTS] 已连接');
  } catch (e) {
    console.error('[TTS] 连接失败:', e);
  }
  
  // 4. 初始化 ASR 客户端
  console.log('[ASR] 初始化...');
  const asrClient = new AsrClient();
  
  // 5. 初始化 SentenceBuffer
  const sentenceBuffer = new SentenceBuffer((sentence) => {
    console.log(`[BUF] 攒够句子: ${sentence}`);
    ttsClient.synthesize(sentence);
  });
  
  // 6. 初始化 InterruptManager
  const interruptManager = new InterruptManager(ttsClient, asrClient, sentenceBuffer);
  
  // 7. 设置事件连接
  // ASR 结果 -> 发送给 Gateway
  asrClient.onFinalResult = (text) => {
    console.log('[ASR] 最终结果:', text);
    gatewayClient.sendMessage(text);
  };
  
  // Gateway token -> 攒句子
  gatewayClient.onToken = (token) => {
    sentenceBuffer.push(token);
  };
  
  // Gateway 完成 -> flush 剩余
  gatewayClient.onComplete = () => {
    sentenceBuffer.flush();
  };
  
  // TTS 音频 -> 推送到 RTC（阶段二启用）
  // ttsClient.onAudioChunk = (pcm) => {
  //   rtcClient.pushAudioFrame(pcm);
  // };
  
  // 8. 初始化 RTC（阶段二才真正用）
  // const rtcClient = new RtcClient();
  // await rtcClient.connect();
  
  // 9. 处理退出
  process.on('SIGINT', async () => {
    console.log('\n👋 收到退出信号，正在关闭...');
    await ttsClient.disconnect();
    asrClient.closeSession();
    process.exit(0);
  });
  
  console.log('✅ VoiceClaw 启动完成');
  console.log(`📋 模式: ${config.useMockGateway ? 'Mock Gateway' : '真实 Gateway'}`);
  console.log('');
  
  // 模拟测试（阶段一）
  if (config.useMockGateway) {
    console.log('💡 模拟测试：3秒后发送测试消息');
    setTimeout(() => {
      console.log('[测试] 发送 "你好"');
      gatewayClient.sendMessage('你好');
    }, 3000);
  }
}

main().catch(console.error);
