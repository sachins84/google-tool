import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const SESSION_TTL_DAYS = 30;

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body' });
    }

    const { username, password } = parsed.data;
    const user = getDb()
      .prepare('SELECT id, username, password_hash, role, status FROM users WHERE username = ?')
      .get(username) as
      | { id: number; username: string; password_hash: string; role: string; status: string }
      | undefined;

    if (!user || user.status !== 'active') {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    if (!bcrypt.compareSync(password, user.password_hash)) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 86400;
    getDb().prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
      .run(token, user.id, expiresAt);

    reply.setCookie('session', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_DAYS * 86400,
    });

    return { user: { id: user.id, username: user.username, role: user.role } };
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies?.session;
    if (token) {
      getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
    }
    reply.clearCookie('session', { path: '/' });
    return { ok: true };
  });

  app.get('/me', { preHandler: requireAuth }, async (req) => {
    return { user: req.user };
  });
}
