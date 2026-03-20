/**
 * OpenClaw App Server — production chat UI
 * Port 3100, serves src/app/ static files + proxies to OpenClaw gateway
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { loadDeviceIdentity, GatewayClient } from './src/gateway-client';

const PORT = 3100;
const APP_DIR = join(__dirname, 'src/app');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.ico':  'image/x-icon',
};

function serveStatic(res: ServerResponse, filePath: string) {
  if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  const ext = extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
}

// ── Gateway connection ─────────────────────────────────────
let gatewayClient: GatewayClient | null = null;
let gatewayReady = false;

async function ensureGateway(): Promise<GatewayClient> {
  if (gatewayClient && gatewayReady) return gatewayClient;
  const device = loadDeviceIdentity();
  if (!device) throw new Error('Device not paired');
  const client = new GatewayClient(device);
  await client.connect();
  gatewayClient = client;
  gatewayReady = true;
  // Forward all gateway events to SSE subscribers
  gatewayClient.onEvent((event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const sub of eventSubscribers) {
      try { sub.write(data); } catch { eventSubscribers.delete(sub); }
    }
  });
  return gatewayClient;
}

// ── SSE event subscribers ──────────────────────────────────
const eventSubscribers = new Set<ServerResponse>();

// ── HTTP Server ────────────────────────────────────────────
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url || '/';

  // Health check
  if (url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /api/agents
  if (url === '/api/agents' && req.method === 'GET') {
    try {
      const client = await ensureGateway();
      const result = await client.call('agents.list', {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // GET /api/sessions
  if (url.startsWith('/api/sessions') && req.method === 'GET') {
    const agentId = new URL(url, 'http://x').searchParams.get('agentId') || undefined;
    try {
      const client = await ensureGateway();
      const result = await client.call('sessions.list', agentId ? { agentId } : {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // GET /api/events — permanent SSE
  if (url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');
    eventSubscribers.add(res);
    req.on('close', () => eventSubscribers.delete(res));
    // Ensure gateway is connected so events can flow
    ensureGateway().catch(e => console.error('[Gateway] events connect failed:', e));
    return; // keep open
  }

  // POST /api/chat — SSE stream
  if (url === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { message, agentId, reuseSession, sessionKey, queueMode } = JSON.parse(body);
        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Message required' })); return;
        }
        if (!agentId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'agentId required' })); return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const apiStartAt = Date.now();
        let firstGatewayDeltaAt: number | null = null;
        let targetRunId: string | undefined;
        let targetSessionKey: string | undefined;

        const client = await ensureGateway();

        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          client.offEvent(eventHandler);
          res.end();
        };

        const eventHandler = (event: unknown) => {
          const e = event as Record<string, unknown>;
          const payload =
            e.payload && typeof e.payload === 'object'
              ? (e.payload as Record<string, unknown>)
              : {};
          const eventRunId = typeof payload.runId === 'string' ? payload.runId : '';
          const eventSessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : '';
          const matchesRun = !!targetRunId && eventRunId === targetRunId;
          const matchesSession = !!targetSessionKey && eventSessionKey === targetSessionKey;
          const shouldForward = targetRunId
            ? (matchesRun || (!eventRunId && matchesSession))
            : matchesSession;

          if (!shouldForward) return;

          res.write(`data: ${JSON.stringify(e)}\n\n`);

          if (e.event === 'agent') {
            const stream = payload?.stream;
            const delta = (payload?.data as Record<string, unknown> | undefined)?.delta;
            if (stream === 'assistant' && typeof delta === 'string' && delta.length > 0 && !firstGatewayDeltaAt) {
              firstGatewayDeltaAt = Date.now();
              const metric = {
                type: 'metric', metric: 'gateway_first_delta',
                at: firstGatewayDeltaAt, ms: firstGatewayDeltaAt - apiStartAt,
              };
              res.write(`data: ${JSON.stringify(metric)}\n\n`);
            }
          }

          if (e.event === 'chat') {
            if (payload.state === 'final' || payload.state === 'error') {
              res.write('data: [DONE]\n\n');
              finish();
            }
          }
        };

        client.onEvent(eventHandler);

        const started = await client.sendAgentMessage(message, agentId, {
          reuseSession: !!reuseSession,
          sessionKey: sessionKey || '',
          queueMode: queueMode || 'interrupt',
        });
        targetRunId = started.runId;
        targetSessionKey = started.sessionKey;
        res.write(`data: ${JSON.stringify({
          type: 'metric', metric: 'session_start',
          runId: targetRunId, sessionKey: targetSessionKey, reuseSession: !!reuseSession,
        })}\n\n`);

        setTimeout(() => {
          if (finished) return;
          res.write('data: [TIMEOUT]\n\n');
          finish();
        }, 60000);

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  // Static files
  const filePath = url === '/'
    ? join(APP_DIR, 'index.html')
    : join(APP_DIR, url.replace(/^\//, ''));
  serveStatic(res, filePath);
});

server.listen(PORT, () => {
  console.log(`App server running at http://localhost:${PORT}`);
  ensureGateway().catch(e => console.error('[Gateway] pre-connect failed:', e));
});
