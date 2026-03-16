import http from 'http';

/**
 * 测试 OpenClaw Gateway 的路由功能
 * 测试三种路由方式：
 * 1. 通过 model 参数: "openclaw:voice"
 * 2. 通过 header: "x-openclaw-agent-id: voice"
 * 3. 默认路由到 main agent
 */

const GATEWAY_URL = 'http://127.0.0.1:18789';
const GATEWAY_TOKEN = ''; // 如果需要认证，填入你的 token

interface TestCase {
  name: string;
  model: string;
  headers?: Record<string, string>;
  expectAgent?: string;
}

const testCases: TestCase[] = [
  {
    name: '测试1: 默认路由到 main',
    model: 'openai-codex/gpt-5.3-codex',
    expectAgent: 'main',
  },
  {
    name: '测试2: model 参数路由 openclaw:voice',
    model: 'openclaw:voice',
    expectAgent: 'voice',
  },
  {
    name: '测试3: model 参数路由 agent:voice',
    model: 'agent:voice',
    expectAgent: 'voice',
  },
  {
    name: '测试4: header 路由 x-openclaw-agent-id',
    model: 'openai-codex/gpt-5.3-codex',
    headers: { 'x-openclaw-agent-id': 'voice' },
    expectAgent: 'voice',
  },
  {
    name: '测试5: header 路由 x-openclaw-agent',
    model: 'openai-codex/gpt-5.3-codex',
    headers: { 'x-openclaw-agent': 'voice' },
    expectAgent: 'voice',
  },
];

function sendRequest(testCase: TestCase): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: testCase.model,
      stream: false,
      messages: [{ role: 'user', content: '你是谁？' }],
    });

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...testCase.headers,
    };

    if (GATEWAY_TOKEN) {
      headers['authorization'] = `Bearer ${GATEWAY_TOKEN}`;
    }

    const req = http.request(
      `${GATEWAY_URL}/v1/chat/completions`,
      {
        method: 'POST',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: data });
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function runTests() {
  console.log('=====================================');
  console.log('OpenClaw Gateway 路由测试');
  console.log(`Gateway: ${GATEWAY_URL}`);
  console.log('=====================================\n');

  for (const test of testCases) {
    console.log(`\n📝 ${test.name}`);
    console.log(`   Model: ${test.model}`);
    if (test.headers) {
      console.log(`   Headers: ${JSON.stringify(test.headers)}`);
    }
    console.log(`   期望路由到: ${test.expectAgent || 'main'}`);

    try {
      const startTime = Date.now();
      const result = await sendRequest(test);
      const latency = Date.now() - startTime;

      console.log(`   状态码: ${result.status}`);
      console.log(`   延迟: ${latency}ms`);

      if (result.status === 200) {
        try {
          const json = JSON.parse(result.body);
          console.log(`   ✅ 成功`);
          console.log(`   回复: ${json.choices?.[0]?.message?.content?.slice(0, 100)}...`);
        } catch {
          console.log(`   ⚠️ 返回非 JSON: ${result.body.slice(0, 200)}`);
        }
      } else if (result.status === 401) {
        console.log(`   ❌ 需要认证 (401)`);
        console.log(`   请设置 GATEWAY_TOKEN`);
      } else if (result.status === 404) {
        console.log(`   ❌ Agent 不存在 (404) - 可能 "${test.expectAgent}" agent 未配置`);
      } else {
        console.log(`   ❌ 错误: ${result.body.slice(0, 200)}`);
      }
    } catch (err) {
      console.log(`   ❌ 请求失败: ${err}`);
    }
  }

  console.log('\n=====================================');
  console.log('测试完成');
  console.log('=====================================');
}

// 快速测试 SSE 流式接口
async function testStreaming() {
  console.log('\n\n=====================================');
  console.log('测试 SSE 流式接口 (stream: true)');
  console.log('=====================================\n');

  const body = JSON.stringify({
    model: 'openclaw:voice',
    stream: true,
    messages: [{ role: 'user', content: '你好' }],
  });

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (GATEWAY_TOKEN) {
    headers['authorization'] = `Bearer ${GATEWAY_TOKEN}`;
  }

  return new Promise<void>((resolve, reject) => {
    const req = http.request(
      `${GATEWAY_URL}/v1/chat/completions`,
      { method: 'POST', headers },
      (res) => {
        console.log(`状态码: ${res.statusCode}`);
        console.log(`Content-Type: ${res.headers['content-type']}`);
        console.log('\n流式数据:');

        let chunkCount = 0;
        res.on('data', (chunk: Buffer) => {
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                console.log('  [DONE]');
              } else {
                try {
                  const json = JSON.parse(data);
                  const content = json.choices?.[0]?.delta?.content;
                  if (content) {
                    process.stdout.write(content);
                    chunkCount++;
                  }
                } catch {
                  // ignore parse error
                }
              }
            }
          }
        });

        res.on('end', () => {
          console.log(`\n\n收到 ${chunkCount} 个内容块`);
          resolve();
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 主函数
async function main() {
  await runTests();

  // 检查是否需要测试流式接口
  const args = process.argv.slice(2);
  if (args.includes('--stream')) {
    await testStreaming();
  } else {
    console.log('\n提示: 添加 --stream 参数测试 SSE 流式接口');
  }
}

main().catch(console.error);
