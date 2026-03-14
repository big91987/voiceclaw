// 火山云 RTC 客户端
// TODO: 根据实际火山云 RTC SDK 文档调整
import { config } from '../config';
import { AudioFrameCallback, VadCallback } from '../types';

export class RtcClient {
  // 回调
  public onAudioFrame: AudioFrameCallback | null = null;
  public onVadStart: VadCallback | null = null;
  public onVadEnd: VadCallback | null = null;
  
  private connected = false;
  
  async connect(): Promise<void> {
    console.log('[RTC] 初始化火山云 RTC...');
    console.log(`[RTC] AppID: ${config.rtcAppId}, Room: ${config.rtcRoomId}`);
    
    // TODO: 实现实际的 RTC 连接
    // 火山云 RTC SDK 示例：
    // const engine = RtcEngine.create(appId);
    // engine.on('onAudioFrame', (room, frame) => { ... });
    // await engine.joinRoom(roomId, userId, token);
    
    this.connected = true;
    console.log('[RTC] 已加入房间（模拟）');
  }
  
  // 推送 TTS 音频帧到房间
  pushAudioFrame(pcm: Buffer): void {
    if (!this.connected) return;
    
    // TODO: 实际推送到 RTC
    // engine.sendAudioFrame(pcm);
  }
  
  // 停止播放（打断时调用）
  stopAudio(): void {
    console.log('[RTC] 停止音频播放');
  }
  
  async disconnect(): Promise<void> {
    this.connected = false;
    console.log('[RTC] 已离开房间');
  }
}
