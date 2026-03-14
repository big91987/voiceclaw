// 豆包 TTS 2.0 客户端（方舟平台 API）
import fetch from 'node-fetch';
import { config } from '../config';
import { TtsAudioCallback } from '../types';

export class TtsClient {
  // 回调
  public onAudioChunk: TtsAudioCallback | null = null;
  public onSynthesisComplete: ((reqId: string) => void) | null = null;
  public onError: ((error: Error) => void) | null = null;
  
  private abortController: AbortController | null = null;
  
  constructor() {}

  async connect(): Promise<void> {
    return;
  }
  
  // 使用 HTTP API 进行语音合成
  async synthesize(text: string, reqId?: string): Promise<Buffer> {
    const requestId = reqId || `req_${Date.now()}`;
    
    // 方舟平台 TTS 2.0 API
    const url = 'https://openspeech.bytedance.com/api/v3/tts';
    
    const requestBody = {
      app: {
        appid: config.ttsAppId,
        token: config.ttsApiKey,
      },
      request: {
        request_id: requestId,
        text: text,
        voice_type: config.ttsVoiceType || 'BV700_V2_streaming',
        encoding: 'wav',  // 使用 wav 格式
        sample_rate: 24000,
        speed_ratio: 1.0,
        volume_ratio: 1.0,
        pitch_ratio: 1.0,
        codec: 'raw',
      },
    };
    
    this.abortController = new AbortController();
    
    try {
      console.log(`[TTS] 发送合成请求: ${text.substring(0, 30)}...`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.ttsApiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'audio/wav',
        },
        body: JSON.stringify(requestBody),
        signal: this.abortController.signal,
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`TTS API error: ${response.status} ${response.statusText} - ${errorText}`);
        console.error('[TTS] 错误:', error.message);
        if (this.onError) {
          this.onError(error);
        }
        throw error;
      }
      
      // 获取音频数据
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);
      
      console.log(`[TTS] 合成完成，音频大小: ${audioBuffer.length} bytes`);
      
      // 触发完成回调
      if (this.onSynthesisComplete) {
        this.onSynthesisComplete(requestId);
      }
      
      // 触发音频数据回调
      if (this.onAudioChunk && audioBuffer.length > 0) {
        this.onAudioChunk(audioBuffer, requestId);
      }
      
      return audioBuffer;
      
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('[TTS] 请求已取消');
      } else {
        console.error('[TTS] 合成错误:', error.message);
        if (this.onError) {
          this.onError(error);
        }
      }
      throw error;
    }
  }
  
  // 取消当前合成
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      console.log('[TTS] 取消合成');
    }
  }
  
  async disconnect(): Promise<void> {
    this.cancel();
  }
}
