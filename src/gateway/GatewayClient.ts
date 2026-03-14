// 龙虾 Gateway 客户端
import { config } from '../config';
import { TokenCallback, CompleteCallback, AnnounceCallback } from '../types';

export class GatewayClient {
  private url: string;
  private token: string;
  private model: string = 'doubao-1-5-pro-32k-250115'; // 需要根据实际配置
  
  // 回调
  public onToken: TokenCallback | null = null;
  public onComplete: CompleteCallback | null = null;
  public onAnnounce: AnnounceCallback | null = null;
  
  constructor(url?: string, token?: string, model?: string) {
    this.url = url || config.openclawGatewayUrl.replace('ws://', 'http://');
    this.token = token || config.openclawGatewayToken;
    if (model) this.model = model;
  }
  
  // 发送消息，流式接收回复
  async sendMessage(text: string): Promise<void> {
    console.log(`[GW] 发送给龙虾: ${text.substring(0, 50)}...`);
    
    const response = await fetch(`${this.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        messages: [
          { role: 'user', content: text },
        ],
      }),
    });
    
    if (!response.ok) {
      console.error('[GW] 请求失败:', response.status, await response.text());
      return;
    }
    
    if (!response.body) {
      console.error('[GW] 响应体为空');
      return;
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      
      // 处理 SSE 格式
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          
          if (data === '[DONE]') {
            console.log('[GW] 接收完成');
            this.onComplete?.();
            return;
          }
          
          try {
            const json = JSON.parse(data);
            const content = json.choices?.[0]?.delta?.content;
            
            if (content) {
              this.onToken?.(content);
            }
          } catch (e) {
            // 非 JSON
          }
        }
      }
    }
  }
}
