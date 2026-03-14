// InterruptManager - 打断管理
import { TtsClient } from '../tts/TtsClient';
import { AsrClient } from '../asr/AsrClient';
import { SentenceBuffer } from './SentenceBuffer';

export class InterruptManager {
  private ttsClient: TtsClient;
  private asrClient: AsrClient;
  private sentenceBuffer: SentenceBuffer;
  
  constructor(ttsClient: TtsClient, asrClient: AsrClient, sentenceBuffer: SentenceBuffer) {
    this.ttsClient = ttsClient;
    this.asrClient = asrClient;
    this.sentenceBuffer = sentenceBuffer;
  }
  
  // 用户开始说话（VAD 检测到）
  onUserSpeechStart(): void {
    console.log('[INT] 用户打断，停止 TTS');
    
    // 1. 立即停止当前 TTS 合成和播放
    this.ttsClient.cancel();
    
    // 2. 清空待合成队列
    this.sentenceBuffer.clear();
    
    // 3. 开始新一轮 ASR 识别
    this.asrClient.startSession();
  }
  
  // 用户停止说话（VAD end）
  onUserSpeechEnd(): void {
    console.log('[INT] 用户停止说话');
    this.asrClient.finishAudio();
  }
}
