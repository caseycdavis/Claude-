import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { LinkDownError, type ConversationService } from '../conversation.js';
import type { AppEvent, EventBus } from '../events.js';
import type { Store } from '../store.js';
import { TranslationError, listModels, pickDefaultModel, type MessagesClient } from '../translator/claude.js';
import { digitsOnly } from '../transport/wa-map.js';
import { TONES, type Tone, type Transport } from '../types.js';
import { LoginLimiter, hashPassphrase, hashToken, newSessionToken, verifyPassphrase } from './auth.js';

export type AppDeps = {
  config: Config;
  store: Store;
  bus: EventBus;
  transport: Transport;
  conversation: ConversationService;
  /** Builds a provider client for a key. Used to check a key and list its models. */
  clientFor: (apiKey: string) => MessagesClient;
  /** Routes added inside the API group, behind the same sign-in gate. Used by the demo mode. */
  extraRoutes?: (api: FastifyInstance) => void;
  now?: () => number;
};

const COOKIE = 'parce_session';
const SESSION_MS = 180 * 24 * 60 * 60 * 1000;
const MIN_PASSPHRASE = 8;
const MIN_PHONE_DIGITS = 8;
const MAX_TEXT = 4000;
/** Route option marking the few API routes reachable without a session. */
const OPEN = { config: { open: true } };

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function text(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text.`);
  if (value.length > max) throw new HttpError(400, `${field} is too long.`);
  return value;
}

function flag(store: Store, key: string, fallback: boolean): boolean {
  const v = store.getSetting(key);
  return v === null ? fallback : v === '1';
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { store, transport, conversation, bus } = deps;
  const now = deps.now ?? Date.now;
  const limiter = new LoginLimiter(5, 15 * 60 * 1000);
  const app = Fastify({ logger: false, trustProxy: 'loopback', bodyLimit: 64 * 1024, forceCloseConnections: true });

  void app.register(cookie);

  /** Open live-update streams. They never finish on their own, so shutdown has to end them. */
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const res of streams) res.end();
    streams.clear();
  });

  const isAuthed = (req: FastifyRequest): boolean => {
    const token = req.cookies?.[COOKIE];
    return typeof token === 'string' && token !== '' && store.hasSession(hashToken(token), now());
  };

  const startSession = (req: FastifyRequest, reply: FastifyReply): void => {
    const token = newSessionToken();
    store.createSession(hashToken(token), now() + SESSION_MS);
    void reply.setCookie(COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      maxAge: Math.floor(SESSION_MS / 1000),
    });
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof LinkDownError) return reply.code(409).send({ error: err.message });
    if (err instanceof TranslationError) return reply.code(502).send({ error: err.message, reason: err.reason });
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'That request could not be read.' });
    }
    return reply.code(500).send({ error: 'Something went wrong on the server.' });
  });

  // Every API route lives in this one group, and the gate is attached to the group.
  // It runs for whichever route the router matched, however the address was spelled.
  void app.register(
    async (api) => {
      api.addHook('onRequest', async (req, reply) => {
        // A browser sends Origin on cross-site requests. Anything not from this app's own address is refused.
        const origin = req.headers.origin;
        if (origin && req.method !== 'GET') {
          let originHost: string | null = null;
          try {
            originHost = new URL(origin).host;
          } catch {
            originHost = null;
          }
          if (originHost !== req.headers.host) return reply.code(403).send({ error: 'This request did not come from the app.' });
        }
        const open = (req.routeOptions.config as { open?: boolean } | undefined)?.open === true;
        if (!open && !isAuthed(req)) return reply.code(401).send({ error: 'Sign in first.' });
      });

      api.setNotFoundHandler((req, reply) => {
        if (!isAuthed(req)) return reply.code(401).send({ error: 'Sign in first.' });
        return reply.code(404).send({ error: 'There is nothing at that address.' });
      });

      deps.extraRoutes?.(api);

      api.get('/state', OPEN, async (req) => {
        const configured = store.getSetting('passphrase_hash') !== null;
        const authed = isAuthed(req);
        if (!authed) return { configured, authed, demo: deps.config.demo };
        return {
          configured,
          authed,
          demo: deps.config.demo,
          hasKey: store.getSetting('anthropic_api_key') !== null,
          model: store.getSetting('model'),
          chatSet: store.getSetting('juan_number') !== null,
          juanNumber: store.getSetting('juan_number'),
          previewBeforeSend: flag(store, 'preview_before_send', true),
          appendEnglish: flag(store, 'append_english', false),
          link: transport.status(),
        };
      });

      api.post('/setup', OPEN, async (req, reply) => {
        if (store.getSetting('passphrase_hash') !== null) throw new HttpError(409, 'This app is already set up. Sign in instead.');
        const passphrase = text((req.body as { passphrase?: unknown } | null)?.passphrase, 'The passphrase', 200);
        if (passphrase.length < MIN_PASSPHRASE) throw new HttpError(400, `Use at least ${MIN_PASSPHRASE} characters.`);
        store.setSetting('passphrase_hash', hashPassphrase(passphrase));
        startSession(req, reply);
        return { ok: true };
      });

      api.post('/login', OPEN, async (req, reply) => {
        const stored = store.getSetting('passphrase_hash');
        if (stored === null) throw new HttpError(409, 'This app has not been set up yet.');
        if (!limiter.allow(req.ip, now())) throw new HttpError(429, 'Too many tries. Wait 15 minutes and try again.');
        const passphrase = text((req.body as { passphrase?: unknown } | null)?.passphrase, 'The passphrase', 200);
        if (!verifyPassphrase(passphrase, stored)) {
          limiter.fail(req.ip, now());
          throw new HttpError(401, 'That passphrase is not right.');
        }
        limiter.reset(req.ip);
        startSession(req, reply);
        return { ok: true };
      });

      api.post('/logout', async (req, reply) => {
        const token = req.cookies[COOKIE];
        if (token) store.deleteSession(hashToken(token));
        void reply.clearCookie(COOKIE, { path: '/' });
        return reply.code(204).send();
      });

      api.put('/settings', async (req) => {
        const body = (req.body ?? {}) as Record<string, unknown>;

        if (body.anthropicApiKey !== undefined) {
          const key = text(body.anthropicApiKey, 'The key', 400).trim();
          if (key === '') {
            store.setSetting('anthropic_api_key', null);
          } else {
            let models: { id: string; name: string }[];
            try {
              models = await listModels(deps.clientFor(key));
            } catch (e) {
              if (e instanceof TranslationError && e.reason === 'auth') throw new HttpError(400, 'That key was rejected. Check it and try again.');
              throw new HttpError(502, 'The key could not be checked right now. Is this machine online?');
            }
            store.setSetting('anthropic_api_key', key);
            if (store.getSetting('model') === null) store.setSetting('model', pickDefaultModel(models));
          }
        }

        if (body.model !== undefined) {
          const model = text(body.model, 'The model', 200).trim();
          store.setSetting('model', model === '' ? null : model);
        }

        if (body.juanNumber !== undefined) {
          const digits = digitsOnly(text(body.juanNumber, 'The number', 40));
          if (digits.length < MIN_PHONE_DIGITS) throw new HttpError(400, 'Enter the full number with its country code.');
          if (digits !== store.getSetting('juan_number')) store.setSetting('juan_lid', null);
          store.setSetting('juan_number', digits);
          transport.setChat(digits);
        }

        for (const [field, key] of [
          ['previewBeforeSend', 'preview_before_send'],
          ['appendEnglish', 'append_english'],
        ] as const) {
          if (body[field] === undefined) continue;
          if (typeof body[field] !== 'boolean') throw new HttpError(400, `${field} must be true or false.`);
          store.setSetting(key, body[field] ? '1' : '0');
        }

        if (body.instructions !== undefined) {
          const v = text(body.instructions, 'The instructions', 8000).trim();
          store.setSetting('instructions', v === '' ? null : v);
        }
        if (body.aboutUs !== undefined) store.setSetting('about_us', text(body.aboutUs, 'The note', 8000).trim());

        return { ok: true };
      });

      api.get('/models', async () => {
        const key = store.getSetting('anthropic_api_key');
        if (key === null) throw new HttpError(400, 'Add a translation key first.');
        const models = await listModels(deps.clientFor(key));
        return { models, suggested: pickDefaultModel(models) };
      });

      api.get('/messages', async (req) => {
        const q = req.query as { before?: string; limit?: string };
        const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
        // `before` is the id of the oldest message the page already has.
        return { messages: store.listMessages({ beforeId: q.before || undefined, limit }) };
      });

      api.post('/draft', async (req) => {
        const body = (req.body ?? {}) as { text?: unknown; tone?: unknown };
        const draft = text(body.text, 'The message');
        if (draft.trim() === '') throw new HttpError(400, 'Write something first.');
        const tone = (body.tone ?? 'base') as Tone;
        if (!TONES.includes(tone)) throw new HttpError(400, 'That tone is not one of the choices.');
        return conversation.preview(draft, tone);
      });

      api.post('/send', async (req) => {
        const body = (req.body ?? {}) as { english?: unknown; spanish?: unknown; back?: unknown };
        const spanish = text(body.spanish, 'The Spanish');
        if (spanish.trim() === '') throw new HttpError(400, 'There is nothing to send.');
        const english = body.english === undefined ? '' : text(body.english, 'The English');
        const back = typeof body.back === 'string' ? body.back.slice(0, MAX_TEXT) : null;
        try {
          return await conversation.send({ english, spanish, back });
        } catch (e) {
          if (e instanceof LinkDownError) throw e;
          throw new HttpError(502, 'WhatsApp did not take the message. Your draft is kept.');
        }
      });

      api.post('/messages/:id/retry', async (req) => {
        const { id } = req.params as { id: string };
        if (store.getMessage(id) === null) throw new HttpError(404, 'That message no longer exists.');
        return conversation.retry(id);
      });

      api.post('/read', async (req, reply) => {
        const ids = (req.body as { ids?: unknown } | null)?.ids;
        if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw new HttpError(400, 'ids must be a list.');
        await conversation.markRead((ids as string[]).slice(0, 500));
        return reply.code(204).send();
      });

      api.post('/link/start', async (_req, reply) => {
        await transport.start();
        return reply.code(204).send();
      });

      api.post('/link/pairing', async (req) => {
        const digits = digitsOnly(text((req.body as { phone?: unknown } | null)?.phone, 'Your number', 40));
        if (digits.length < MIN_PHONE_DIGITS) throw new HttpError(400, 'Enter your own full number with its country code.');
        try {
          return { code: await transport.requestPairingCode(digits) };
        } catch (e) {
          throw new HttpError(409, e instanceof Error ? e.message : 'A number code is not available right now.');
        }
      });

      api.post('/link/logout', async (_req, reply) => {
        await transport.logout();
        return reply.code(204).send();
      });

      api.get('/events', (req, reply) => {
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        write('link', transport.status());
        const unsubscribe = bus.subscribe((e: AppEvent) => {
          if (e.type === 'message') write('message', e.message);
          else write('link', e.status);
        });
        const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
        streams.add(res);
        req.raw.on('close', () => {
          clearInterval(beat);
          unsubscribe();
          streams.delete(res);
        });
      });
    },
    { prefix: '/api' },
  );

  const hasWeb = fs.existsSync(deps.config.webDir);
  if (hasWeb) void app.register(fastifyStatic, { root: deps.config.webDir, wildcard: false });

  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || !hasWeb) return reply.code(404).send({ error: 'There is nothing at that address.' });
    // The web app handles its own paths.
    return reply.sendFile('index.html');
  });

  return app;
}
