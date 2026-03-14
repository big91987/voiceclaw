// Mock Gateway - 阶段一用
import http from 'http';
import { config } from '../config';

const MOCK_REPLIES = [
  '好的，我明白了。你刚才说的是什么来着？',
  '这是一个很好的问题。让我来帮你分析一下。',
  '明白了，我已经记下来了，稍后会处理。',
  '收到，这个任务我会安排处理的，完成后告诉你。',
  '嗯，今天天气确实不错，你有什么需要我帮忙的吗？',
];

export class MockGateway {
  private server: http.Server | null = null;
  
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }
        
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', async () => {
            // 解析请求
            try {
              const json = JSON.parse(body);
              const userMessage = json.messages?.[json.messages.length - 1]?.content || '';
              console.log(`[MockGW] 收到消息: ${userMessage}`);
              
              // 随机延迟模拟思考
              const delay = 200 + Math.random() * 600;
              await new Promise(r => setTimeout(r, delay));
              
              // 随机选回复
              const reply = MOCK_REPLIES[Math.floor(Math.random() * MOCK_REPLIES.length)];
              
              // 流式返回 SSE
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
              });
              
              // 逐字返回
              for (const char of reply) {
                const data = JSON.stringify({
                  choices: [{ delta: { content: char } }],
                });
                res.write(`data: ${data}\n\n`);
                await new Promise(r => setTimeout(r, 30));
              }
              
              res.write('data: [DONE]\n\n');
              res.end();
              
              // 5 秒后发送 announce
              setTimeout(() => {
                console.log('[MockGW] 发送 announce');
                // 这里简化处理，实际应该推送到主控
              }, 5000);
              
            } catch (e) {
              res.writeHead(500);
              res.end('Error');
            }
          });
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });
      
      this.server.listen(config.mockGatewayPort, () => {
        console.log(`[MockGW] 已启动: http://localhost:${config.mockGatewayPort}`);
        resolve();
      });
    });
  }
  
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('[MockGW] 已停止');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
