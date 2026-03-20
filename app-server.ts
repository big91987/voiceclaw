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
