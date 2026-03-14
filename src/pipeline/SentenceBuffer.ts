// SentenceBuffer - 把 LLM 流式 token 攒成完整句子
import { SentenceCallback } from '../types';

export class SentenceBuffer {
  private buffer = '';
  private minChars: number;
  private onSentence: SentenceCallback;
  
  // 句末标点
  private readonly endPunctuation = ['。', '！', '？', '.', '!', '?'];
  
  constructor(onSentence: SentenceCallback, minChars: number = 5) {
    this.onSentence = onSentence;
    this.minChars = minChars;
  }
  
  // 喂入一个 token
  push(token: string): void {
    this.buffer += token;
    
    // 检查是否是句末标点
    const lastChar = this.buffer.slice(-1);
    if (this.endPunctuation.includes(lastChar) && this.buffer.length >= this.minChars) {
      this.flush();
    }
  }
  
  // 强制 flush
  flush(): void {
    if (this.buffer.length > 0) {
      console.log(`[BUF] 触发句子: ${this.buffer}`);
      this.onSentence(this.buffer);
      this.buffer = '';
    }
  }
  
  // 清空缓冲（打断时）
  clear(): void {
    this.buffer = '';
    console.log('[BUF] 清空缓冲');
  }
}
