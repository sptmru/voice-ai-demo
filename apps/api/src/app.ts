import { createHash, randomBytes } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import pino from 'pino';
import { z } from 'zod';
import type { Pool } from 'pg';
import {
  scenarioSchema,
  scenarios,
  type Repository,
  type RetrievalService,
} from '../../../packages/core/src/domain.js';
import { SupportRuntime } from '../../../packages/core/src/runtime.js';
import { EventStream } from './events.js';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: ['req.headers.cookie', '*.apiKey', '*.credentials', '*.authorization'],
});
const idSchema = z.string().uuid();
export function ownerFromRequest(request: Pick<Request, 'headers'>): string | undefined {
  const value = request.headers.cookie
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('relay_owner='))
    ?.slice(12);
  return value && /^[a-f0-9]{64}$/.test(value) ? createHash('sha256').update(value).digest('hex') : undefined;
}

export function createApp(repo: Repository, rag: RetrievalService, pool: Pool) {
  const app = express();
  const stream = new EventStream(repo);
  const runtime = new SupportRuntime(repo, rag, stream.emitForSession);
  const allowedOrigins = new Set(
    (process.env.WEB_ORIGIN || 'http://localhost:3100').split(',').map((s) => s.trim()),
  );
  const active = new Set<string>();
  const voiceActive = new Set<string>();
  let confirmationNotifier: ((id: string, result: unknown) => Promise<void>) | undefined;
  app.disable('x-powered-by');
  app.use(
    cors({ origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)), credentials: true }),
  );
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', (req, res, next) => {
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(
    '/api',
    rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false }),
  );
  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    const documents = await rag.listDocuments();
    res.json({
      status: documents.length ? 'ready' : 'unseeded',
      database: true,
      documents: documents.length,
    });
  });
  app.get('/api/config', (_req, res) =>
    res.json({
      scenarios,
      voiceProvider: process.env.VOICE_PROVIDER || 'gemini',
      providers: {
        gemini: {
          configured: Boolean(process.env.GEMINI_API_KEY),
          model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview',
        },
        openai: {
          configured: Boolean(process.env.OPENAI_API_KEY),
          model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
        },
      },
      voiceUrl: process.env.VOICE_PUBLIC_URL || null,
      textMode: 'Local diagnostic policy',
      externalSystems: 'Local PostgreSQL mocks',
    }),
  );
  app.use('/api', (req, res, next) => {
    if (!ownerFromRequest(req)) {
      const token = randomBytes(32).toString('hex');
      res.cookie('relay_owner', token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.COOKIE_SECURE === 'true',
        maxAge: 7 * 86400000,
        path: '/',
      });
      req.headers.cookie = `${req.headers.cookie || ''}; relay_owner=${token}`;
    }
    next();
  });
  const owned = async (req: Request, sessionId = String(req.params.id)) => {
    idSchema.parse(sessionId);
    const result = await pool.query(
      'SELECT 1 FROM api_session_owners WHERE session_id=$1 AND owner_hash=$2',
      [sessionId, ownerFromRequest(req)],
    );
    if (!result.rowCount) throw Object.assign(new Error('Session not found'), { status: 404 });
  };
  const lock = async <T>(id: string, operation: () => Promise<T>) => {
    if (active.has(id))
      throw Object.assign(new Error('An operation is already in progress. Please wait.'), { status: 409 });
    active.add(id);
    try {
      return await operation();
    } finally {
      active.delete(id);
    }
  };
  app.get('/api/sessions', async (req, res) => {
    const own = await pool.query<{ session_id: string }>(
      'SELECT session_id FROM api_session_owners WHERE owner_hash=$1',
      [ownerFromRequest(req)],
    );
    const ids = new Set(own.rows.map((r) => r.session_id));
    res.json((await repo.listSessions([...ids])).filter((s) => ids.has(s.id)));
  });
  app.post('/api/sessions', async (req, res) => {
    const { scenarioId } = z.object({ scenarioId: scenarioSchema }).strict().parse(req.body);
    const session = await runtime.startSession(scenarioId);
    await pool.query('INSERT INTO api_session_owners(session_id,owner_hash) VALUES ($1,$2)', [
      session.id,
      ownerFromRequest(req),
    ]);
    res.status(201).json({ session, customer: await repo.getCustomer(session.customerId) });
  });
  app.get('/api/sessions/:id', async (req, res) => {
    await owned(req);
    const session = await repo.getSession(String(req.params.id));
    const [customer, events, tickets, actions, confirmations, memory] = await Promise.all([
      repo.getCustomer(session.customerId),
      repo.getEvents(session.id),
      repo.getTickets(session.id),
      repo.getActions(session.id),
      repo.getConfirmations(session.id),
      repo.getMemory(session.customerId),
    ]);
    res.json({ session, customer, events, tickets, actions, confirmations, memory });
  });
  app.get('/api/sessions/:id/events', async (req, res) => {
    await owned(req);
    const afterId = z.coerce
      .number()
      .int()
      .min(0)
      .parse(req.headers['last-event-id'] || req.query.after || 0);
    res
      .status(200)
      .set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    await stream.subscribe(String(req.params.id), res, afterId);
  });
  app.post('/api/sessions/:id/messages', async (req, res) => {
    await owned(req);
    const session = await repo.getSession(String(req.params.id));
    if (session.status !== 'active') throw Object.assign(new Error('Session has ended'), { status: 409 });
    if (voiceActive.has(session.id))
      throw Object.assign(
        new Error('Use the live voice connection or disconnect voice before using local text mode.'),
        { status: 409 },
      );
    const { text } = z
      .object({ text: z.string().trim().min(1).max(4000) })
      .strict()
      .parse(req.body);
    const result = await lock(String(req.params.id), () => runtime.message(String(req.params.id), text));
    res.json(result);
  });
  app.post('/api/sessions/:id/confirmations/:confirmationId', async (req, res) => {
    await owned(req);
    idSchema.parse(req.params.confirmationId);
    const session = await repo.getSession(String(req.params.id));
    if (session.status !== 'active') throw Object.assign(new Error('Session has ended'), { status: 409 });
    const confirmation = (await repo.getConfirmations(session.id)).find(
      (c) => c.id === req.params.confirmationId,
    );
    if (!confirmation) throw Object.assign(new Error('Confirmation not found'), { status: 404 });
    if (confirmation.status === 'expired')
      throw Object.assign(new Error('Confirmation expired'), { status: 410 });
    if (confirmation.status !== 'pending')
      throw Object.assign(new Error('Confirmation was already consumed'), { status: 409 });
    const { approve } = z.object({ approve: z.boolean() }).strict().parse(req.body);
    const result = await lock(String(req.params.id), () =>
      runtime.confirm(String(req.params.id), String(req.params.confirmationId), approve),
    );
    // An upstream failure cannot turn a committed local action into an HTTP failure.
    try {
      await confirmationNotifier?.(session.id, result);
    } catch {
      await stream.emitForSession(session.id)('error', {
        source: 'voice',
        message: 'The confirmation result was saved, but could not be delivered to the voice provider.',
      });
    }
    res.json(result);
  });
  app.post('/api/sessions/:id/end', async (req, res) => {
    await owned(req);
    if (voiceActive.has(String(req.params.id)))
      throw Object.assign(new Error('Disconnect voice before ending the support session.'), { status: 409 });
    res.json(await lock(String(req.params.id), () => runtime.endSession(String(req.params.id))));
  });
  app.get('/api/knowledge', async (_req, res) => res.json(await rag.listDocuments()));
  app.post('/api/knowledge/search', async (req, res) => {
    const { query } = z
      .object({ query: z.string().trim().min(1).max(1000) })
      .strict()
      .parse(req.body);
    res.json(await rag.search(query));
  });
  const errorHandler = (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const e = error as { status?: number; code?: string; name?: string };
    const status =
      error instanceof z.ZodError
        ? 400
        : e.status ||
          (e.code === 'LIMIT_FILE_SIZE'
            ? 413
            : e.name === 'MulterError'
              ? 400
              : e.code === '23505'
                ? 409
                : 500);
    logger.error(
      { code: e.code, name: e.name, method: req.method, path: req.path, status },
      'Request failed',
    );
    if (!res.headersSent)
      res.status(status).json({
        error:
          status === 500
            ? 'The operation failed. Please retry; check the local API logs if it persists.'
            : error instanceof Error
              ? error.message
              : 'Invalid request',
      });
  };
  return {
    app,
    runtime,
    stream,
    owned,
    lock,
    errorHandler,
    allowedOrigins,
    voiceActive,
    isSessionBusy: (id: string) => active.has(id),
    setConfirmationNotifier: (notifier: typeof confirmationNotifier) => {
      confirmationNotifier = notifier;
    },
  };
}
