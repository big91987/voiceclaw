import dotenv from 'dotenv';
import { Config } from './types';

dotenv.config();

export const config: Config = {
  // RTC
  rtcAppId: process.env.RTC_APP_ID || '',
  rtcAppKey: process.env.RTC_APP_KEY || '',
  rtcRoomId: process.env.RTC_ROOM_ID || 'voiceclaw-main',
  rtcUserId: process.env.RTC_USER_ID || 'server',
  
  // ASR
  asrApiKey: process.env.ASR_API_KEY || '',
  asrAppId: process.env.ASR_APP_ID || '',
  asrCluster: process.env.ASR_CLUSTER || 'volcengine_streaming_common',
  
  // TTS
  ttsApiKey: process.env.TTS_API_KEY || '',
  ttsAppId: process.env.TTS_APP_ID || '',
  ttsVoiceType: process.env.TTS_VOICE_TYPE || 'BV700_V2_streaming',
  ttsCluster: process.env.TTS_CLUSTER || 'volcano_tts',
  
  // Gateway
  openclawGatewayUrl: process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789',
  openclawGatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || '',
  
  // Mock
  useMockGateway: process.env.USE_MOCK_GATEWAY === 'true',
  mockGatewayPort: parseInt(process.env.MOCK_GATEWAY_PORT || '19001'),
};

export function validateConfig(): boolean {
  const required = [
    'rtcAppId', 'rtcAppKey',
    'asrApiKey', 'asrAppId',
    'ttsApiKey', 'ttsAppId',
  ];
  
  for (const key of required) {
    if (!config[key as keyof Config]) {
      console.error(`❌ 缺少配置: ${key}`);
      return false;
    }
  }
  
  console.log('✅ 配置验证通过');
  return true;
}
