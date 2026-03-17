// VoiceClaw 语音通话服务器 - 独立服务
// 功能: WebSocket 音频接收 -> ASR -> Gateway -> TTS -> 音频发送

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import WebSocket, { WebSocketServer } from 'ws';
import { AsrClient } from './src/asr/AsrClient';
import { TtsClient } from './src/tts/TtsClient';
import { SentenceBuffer } from './src/pipeline/SentenceBuffer';
import { v4 as uuidv4 } from 'uuid';

const HTTP_PORT = 3457;

// 加载 device identity
function loadDeviceIdentity() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const devicePath = path.join(os.homedir(), '.openclaw', 'voiceclaw-device.json');

  try {
    const data = fs.readFileSync(devicePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// 音频转换工具
function convertFloat32ToInt16(float32Array: Float32Array): Buffer {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return Buffer.from(int16Array.buffer);
}

function convertInt16ToFloat32(buffer: Buffer): Float32Array {
  const int16Array = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768;
  }
  return float32Array;
}

// 通话会话管理
class CallSession {
  private ws: WebSocket;
  private agentId: string;
  private asrClient: AsrClient;
  private ttsClient: TtsClient;
  private sentenceBuffer: SentenceBuffer;

  private isListening = false;
  private isSpeaking = false;
  private currentAudioChunks: Buffer[] = [];
  private sessionId: string;
  private lastFinalText = '';

  constructor(ws: WebSocket, agentId: string) {
    this.ws = ws;
    this.agentId = agentId;
    this.sessionId = uuidv4();

    // 初始化 ASR
    this.asrClient = new AsrClient();
    this.asrClient.onPartialResult = (text) => {
      console.log(`[Call ${this.sessionId}] 📝 ASR partial: "${text}"`);
      if (!this.isProcessingSpeech) {
        this.send({ type: 'user_partial', text });
      }
    };
    this.asrClient.onFinalResult = (text, isFinal) => {
      console.log(`[Call ${this.sessionId}] 🎯 ASR final: "${text}", isFinal=${isFinal}, processing=${this.isProcessingSpeech}`);
      if (!isFinal || !text.trim()) return;

      // 提取增量：去掉上次已处理的前缀
      let newText = text;
      if (this.lastFinalText && text.startsWith(this.lastFinalText)) {
        newText = text.slice(this.lastFinalText.length).trim();
        if (!newText) {
          console.log(`[Call ${this.sessionId}] 无增量内容，跳过`);
          return;
        }
        console.log(`[Call ${this.sessionId}] 增量提取: "${newText}"`);
      }

      this.lastFinalText = text;
      this.handleUserSpeech(newText);
    };

    // 初始化 TTS
    this.ttsClient = new TtsClient();
    this.ttsClient.onAudioChunk = (chunk) => {
      this.handleTtsChunk(chunk);
    };
    this.ttsClient.onSynthesisComplete = () => {
      this.handleTtsComplete();
    };

    // 句子缓冲
    this.sentenceBuffer = new SentenceBuffer((sentence) => {
      this.synthesizeSentence(sentence);
    });

    // 启动 ASR 会话（等待完成）
    this.initAsr();
  }

  private async initAsr() {
    try {
      await this.asrClient.startSession();
      console.log(`[⏱ ${Date.now()}] ✅ ASR 已就绪，可以开始对话`);
      this.send({ type: 'asr_ready' });
    } catch (err) {
      console.error('[Call] ASR 启动失败:', err);
    }
  }

  private send(msg: object) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // 处理用户语音（ASR 最终结果）
  private isProcessingSpeech = false;

  private pendingText: string | null = null;

  private async handleUserSpeech(text: string) {
    if (this.isProcessingSpeech) {
      // 处理中，缓存为待处理文本
      console.log(`[Call ${this.sessionId}] 处理中，缓存: "${text.substring(0, 30)}"`);
      this.pendingText = text;
      return;
    }

    this.isProcessingSpeech = true;
    this.lastFinalText = text;
    const t0 = Date.now();
    console.log(`[⏱ ${t0}] ==== ASR final → 开始处理 ==== "${text.substring(0, 30)}"`);

    try {
      this.send({ type: 'user_transcript', text });

      // 打断检测
      if (this.isSpeaking) {
        console.log(`[⏱ +${Date.now()-t0}ms] 执行打断`);
        await this.interrupt();
      }

      this.send({ type: 'thinking' });

      // 通过 test-server 调用 Gateway
      console.log(`[⏱ +${Date.now()-t0}ms] → test-server 请求开始`);
      this.send({ type: 'ai_start' });
      let fullText = '';
      let firstToken = true;

      const response = await fetch('http://localhost:3456/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, agentId: this.agentId }),
      });

      if (!response.ok) {
        throw new Error(`Chat API error: ${response.status}`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              console.log(`[⏱ +${Date.now()-t0}ms] ← Gateway 流结束，总长=${fullText.length}`);
              break;
            }
            if (data === '[TIMEOUT]') throw new Error('Timeout');

            try {
              const event = JSON.parse(data);
              if (event.event === 'agent' && event.payload?.stream === 'assistant' && event.payload?.data?.delta) {
                const token = event.payload.data.delta;
                if (firstToken) {
                  console.log(`[⏱ +${Date.now()-t0}ms] ← Gateway 首个 token 到达`);
                  firstToken = false;
                }
                fullText += token;
                this.send({ type: 'ai_transcript', text: fullText });
                this.sentenceBuffer.push(token);
              }
            } catch (e) {
              // ignore parse errors
            }
          }
        }
      }
      this.sentenceBuffer.flush();
      this.send({ type: 'ai_end' });
    } catch (err: any) {
      console.error(`[Call ${this.sessionId}] 处理失败:`, err.message);
      this.send({ type: 'error', message: err.message || 'Gateway 连接失败' });
    } finally {
      console.log(`[⏱ +${Date.now()-t0}ms] ==== 处理结束 ====`);
      this.asrClient.resetFinished();
      this.isProcessingSpeech = false;
    }
  }

  // 合成句子（只负责TTS，不发送字幕，字幕已在handleUserSpeech流式发送）
  private async synthesizeSentence(sentence: string) {
    const ttsT0 = Date.now();
    console.log(`[⏱ ${ttsT0}] → TTS 开始合成: "${sentence.substring(0, 20)}"`);

    if (!this.isSpeaking) {
      this.isSpeaking = true;
    }

    try {
      await this.ttsClient.synthesize(sentence);
      console.log(`[⏱ +${Date.now()-ttsT0}ms] TTS 合成完成`);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('[TTS] 合成被取消');
      } else {
        console.error('[TTS] 合成失败:', err);
      }
    }
  }

  private ttsFirstChunk = true;
  private ttsT0 = 0;

  private handleTtsChunk(chunk: Buffer) {
    if (this.ttsFirstChunk) {
      console.log(`[⏱ TTS 首个音频块到达，size=${chunk.length}]`);
      this.ttsFirstChunk = false;
    }
    this.currentAudioChunks.push(chunk);
    // 发送音频数据给前端
    this.send({
      type: 'audio_chunk',
      data: chunk.toString('base64')
    });
  }

  // TTS 完成
  private handleTtsComplete() {
    this.send({ type: 'audio_end' });
    this.isSpeaking = false;
    this.send({ type: 'ai_end' });
    this.currentAudioChunks = [];
  }

  private async restartAsr() {
    this.asrClient.closeSession();
    await new Promise(r => setTimeout(r, 200));
    await this.asrClient.startSession(); // 等待ASR完全准备好
    console.log('[Call] ASR 已重启并准备就绪');
  }

  // 打断
  private async interrupt() {
    console.log(`[Call ${this.sessionId}] 被打断`);
    this.ttsClient.cancel();
    this.sentenceBuffer.clear();
    this.currentAudioChunks = [];
    this.isSpeaking = false;
    this.isProcessingSpeech = false; // 重置处理状态
    this.send({ type: 'interrupted' });
    // 打断时重启 ASR
    await this.restartAsr();
  }

  // 接收音频数据
  private audioFrameCount = 0;
  private lastHandleAudioLog = 0;
  handleAudio(data: Buffer) {
    if (!this.isListening) {
      this.isListening = true;
    }
    // 发送给 ASR
    this.audioFrameCount++;
    const now = Date.now();
    if (now - this.lastHandleAudioLog > 500) {
      const asrState = !this.asrClient.isStarted ? 'NOT_STARTED' :
                       this.asrClient.isFinished ? 'FINISHED' : 'OK';
      console.log(`[Call ${this.sessionId}] 📥 handleAudio #${this.audioFrameCount} size=${data.length} processing=${this.isProcessingSpeech} ASR=${asrState}`);
      this.lastHandleAudioLog = now;
    }
    this.asrClient.sendAudio(data);
  }

  // 结束会话
  end() {
    this.asrClient.closeSession();
    this.ttsClient.disconnect();
    this.isListening = false;
    this.isSpeaking = false;
  }
}

// HTTP 服务器
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 静态页面
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = readFileSync(resolve(__dirname, 'voice-call.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('Error loading page');
    }
    return;
  }

  // API: 获取 agent 列表
  if (url.pathname === '/api/agents') {
    const device = loadDeviceIdentity();
    if (!device) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Device not configured' }));
      return;
    }

    // 返回常用 agents
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      { id: 'voice', name: 'Voice Agent' },
      { id: 'main', name: 'Main Agent' },
      { id: 'zoe', name: 'Zoe' }
    ]));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// WebSocket 服务器
const wss = new WebSocketServer({ server, path: '/ws/call' });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const agentId = url.searchParams.get('agentId');

  if (!agentId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing agentId' }));
    ws.close();
    return;
  }

  console.log(`[WebSocket] 新连接, agentId: ${agentId}`);

  // 创建通话会话
  const session = new CallSession(ws, agentId);

  ws.on('message', (data) => {
    if (data instanceof Buffer) {
      session.handleAudio(data);
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket] 连接关闭');
    session.end();
  });

  ws.on('error', (err) => {
    console.error('[WebSocket] 错误:', err);
  });
});

server.listen(HTTP_PORT, () => {
  console.log('='.repeat(50));
  console.log('🎙️ VoiceClaw 语音通话服务器');
  console.log('='.repeat(50));
  console.log(`📱 页面地址: http://localhost:${HTTP_PORT}`);
  console.log(`📞 WebSocket: ws://localhost:${HTTP_PORT}/ws/call`);
  console.log('');
  console.log('功能:');
  console.log('  - 浏览器麦克风音频采集');
  console.log('  - 火山 ASR 实时语音识别');
  console.log('  - OpenClaw Gateway 对话');
  console.log('  - 豆包 TTS 语音合成');
  console.log('  - 流式音频播放');
  console.log('  - 语音打断支持');
  console.log('='.repeat(50));
});
