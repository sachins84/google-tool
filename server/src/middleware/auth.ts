import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/init.js';

export interface SessionUser {
  id: number;
  username: string;
  role: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies?.session;
  if (!token) {
    reply.code(401).send({ error: 'Not authenticated' });
    return;
  }

  const row = getDb()
    .prepare(
      `SELECT u.id, u.username, u.role, s.expires_at
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.token = ?`
    )
    .get(token) as { id: number; username: string; role: string; expires_at: number } | undefined;

  if (!row || row.expires_at < Math.floor(Date.now() / 1000)) {
    reply.code(401).send({ error: 'Session expired' });
    return;
  }

  req.user = { id: row.id, username: row.username, role: row.role };
}
