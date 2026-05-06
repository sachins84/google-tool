/**
 * MCP HTTP transport at /mcp — for claude.ai web integration.
 * Stateless: each POST creates a fresh McpServer, no shared mutable state.
 *
 * Optional Bearer-token auth via MCP_SECRET in .env. When unset (default for
 * local dev), the endpoint is open — only safe because the dev server binds
 * to localhost. Set MCP_SECRET before exposing on a network.
 */

import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { registerTools } from '../services/mcp-tools.js';

function checkAuth(authHeader: string | undefined): boolean {
  const secret = process.env.MCP_SECRET;
  if (!secret) return true;
  return authHeader === `Bearer ${secret}`;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void> {
  const server = new McpServer({
    name: 'google-ads-tool',
    version: '1.0.0',
  });
  registerTools(server);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  // Allow Fastify to pass the raw req/res to the MCP transport (which expects Node's http types).
  app.post('/', async (req, reply) => {
    if (!checkAuth(req.headers.authorization)) return reply.code(401).send({ error: 'Unauthorized' });
    try {
      await handleRequest(req.raw, reply.raw, req.body);
      // The transport writes directly to res; tell Fastify we're done.
      reply.hijack();
    } catch (err) {
      app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'MCP error');
      if (!reply.sent) reply.code(500).send({ error: 'MCP request failed' });
    }
  });

  app.get('/', async (req, reply) => {
    if (!checkAuth(req.headers.authorization)) return reply.code(401).send({ error: 'Unauthorized' });
    try {
      await handleRequest(req.raw, reply.raw);
      reply.hijack();
    } catch (err) {
      app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'MCP SSE error');
      if (!reply.sent) reply.code(500).send({ error: 'MCP request failed' });
    }
  });

  app.delete('/', async () => ({ ok: true }));

  app.get('/info', async () => ({
    name: 'google-ads-tool',
    version: '1.0.0',
    transport: 'streamable-http',
    auth: config.NODE_ENV === 'production' && !process.env.MCP_SECRET
      ? 'WARNING: open (no MCP_SECRET set in production)'
      : process.env.MCP_SECRET ? 'bearer-token' : 'open (dev only)',
    tools: [
      'list_brands',
      'list_accessible_accounts',
      'get_campaigns',
      'get_network_split',
      'get_daily_insights',
      'get_audit_log',
    ],
  }));
}
