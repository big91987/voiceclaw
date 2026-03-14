// VoiceClaw 类型定义

export interface Config {
  // RTC
  rtcAppId: string;
  rtcAppKey: string;
  rtcRoomId: string;
  rtcUserId: string;
  
  // ASR
  asrApiKey: string;
  asrAppId: string;
  asrCluster: string;
  
  // TTS
  ttsApiKey: string;
  ttsAppId: string;
  ttsVoiceType: string;
  ttsCluster: string;
  
  // Gateway
  openclawGatewayUrl: string;
  openclawGatewayToken: string;
  
  // Mock
  useMockGateway: boolean;
  mockGatewayPort: number;
}

// 事件类型
export type AudioFrameCallback = (pcm: Buffer) => void;
export type VadCallback = () => void;
export type AsrResultCallback = (text: string, isFinal: boolean) => void;
export type TokenCallback = (token: string) => void;
export type CompleteCallback = () => void;
export type AnnounceCallback = (message: string) => void;
export type SentenceCallback = (sentence: string) => void;
export type TtsAudioCallback = (pcm: Buffer, reqId: string) => void;
