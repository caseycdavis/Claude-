import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ConversationService } from '../src/server/conversation.js';
import { EventBus } from '../src/server/events.js';
import { LoginLimiter, hashPassphrase, verifyPassphrase } from '../src/server/http/auth.js';
import { buildApp } from '../src/server/http/app.js';
import { Store } from '../src/server/store.js';
import type { MessagesClient } from '../src/server/translator/claude.js';
import { FakeTranslator } from '../src/server/translator/fake.js';
import { FakeTransport } from '../src/server/transport/fake.js';

const SECRET_KEY = 'sk-test-SECRET-KEY-VALUE-123';
const PASS = 'correct horse battery';

let app: FastifyInstance;
let store: Store;
let transport: FakeTransport;
let translator: FakeTranslator;
let bus: EventBus;
let clock: number;
let keyAccepted: boolean;
const bodies: string[] = [];

function fakeClient(): MessagesClient {
  return {
    messages: {
      parse: async () => {
        throw new Error('not used');
      },
      create: async () => {
        throw new Error('not used');
      },
    },
    models: {
      list() {
        return (async function* () {
          if (!keyAccepted) {
            const { default: Anthropic } = await import('@anthropic-ai/sdk');
            throw new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers());
          }
          yield { id: 'claude-small-1', display_name: 'Small 1', created_at: '2026-09-01T00:00:00Z' };
          yield { id: 'claude-opus-9', display_name: 'Opus 9', created_at: '2026-06-01T00:00:00Z' };
        })();
      },
    },
  };
}

beforeEach(async () => {
  clock = 1_000_000;
  keyAccepted = true;
  bodies.length = 0;
  store = new Store(':memory:');
  transport = new FakeTransport(() => clock);
  translator = new FakeTranslator();
  bus = new EventBus();
  const conversation = new ConversationService({ store, translator: () => translator, transport, bus, now: () => clock });
  conversation.start();
  app = buildApp({
    config: { port: 0, host: '127.0.0.1', dataDir: '/nonexistent', demo: false, webDir: '/nonexistent' },
    store,
    bus,
    transport,
    conversation,
    clientFor: () => fakeClient(),
    now: () => clock,
    extraRoutes: (api) => {
      api.post('/demo/ping', async () => ({ pong: true }));
    },
  });
  app.addHook('onSend', async (_req, _reply, payload) => {
    if (typeof payload === 'string') bodies.push(payload);
    return payload;
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function signIn(): Promise<Record<string, string>> {
  const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { passphrase: PASS } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'parce_session')!;
  return { parce_session: cookie.value };
}

describe('auth helpers', () => {
  test('a passphrase verifies against its own hash and nothing else', () => {
    const h = hashPassphrase(PASS);
    expect(h).not.toContain(PASS);
    expect(verifyPassphrase(PASS, h)).toBe(true);
    expect(verifyPassphrase('wrong', h)).toBe(false);
    expect(verifyPassphrase(PASS, 'garbage')).toBe(false);
    expect(hashPassphrase(PASS)).not.toBe(h);
  });

  test('the limiter blocks after the allowed failures and forgets them after the window', () => {
    const l = new LoginLimiter(2, 1000);
    expect(l.allow('a', 0)).toBe(true);
    l.fail('a', 0);
    l.fail('a', 10);
    expect(l.allow('a', 20)).toBe(false);
    expect(l.allow('b', 20)).toBe(true);
    expect(l.allow('a', 1011)).toBe(true);
  });
});

describe('sign-in', () => {
  test('every protected route returns 401 without a cookie', async () => {
    const routes: [string, string][] = [
      ['PUT', '/api/settings'],
      ['GET', '/api/models'],
      ['GET', '/api/messages'],
      ['POST', '/api/draft'],
      ['POST', '/api/send'],
      ['POST', '/api/messages/x/retry'],
      ['POST', '/api/read'],
      ['POST', '/api/link/start'],
      ['POST', '/api/link/pairing'],
      ['POST', '/api/link/logout'],
      ['GET', '/api/events'],
      ['POST', '/api/logout'],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject({ method: method as 'GET', url, payload: method === 'GET' ? undefined : {} });
      expect(`${method} ${url} ${res.statusCode}`).toBe(`${method} ${url} 401`);
    }
  });

  test('state says nothing about the link or settings before sign-in', async () => {
    store.setSetting('juan_number', '573001234567');
    const res = await app.inject({ method: 'GET', url: '/api/state' });
    expect(res.json()).toEqual({ configured: false, authed: false, demo: false });
  });

  test('setup works once and a second setup returns 409', async () => {
    await signIn();
    const again = await app.inject({ method: 'POST', url: '/api/setup', payload: { passphrase: 'another passphrase' } });
    expect(again.statusCode).toBe(409);
    expect(verifyPassphrase(PASS, store.getSetting('passphrase_hash')!)).toBe(true);
  });

  test('setup rejects a 7-character passphrase', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { passphrase: '1234567' } });
    expect(res.statusCode).toBe(400);
    expect(store.getSetting('passphrase_hash')).toBeNull();
  });

  test('the session cookie is HttpOnly and SameSite=Lax', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { passphrase: PASS } });
    const cookie = res.cookies.find((c) => c.name === 'parce_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.value.length).toBeGreaterThanOrEqual(32);
  });

  test('login with the right passphrase signs in, and logout ends the session', async () => {
    await signIn();
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { passphrase: PASS } });
    expect(login.statusCode).toBe(200);
    const cookies = { parce_session: login.cookies.find((c) => c.name === 'parce_session')!.value };
    expect((await app.inject({ method: 'GET', url: '/api/messages', cookies })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/logout', cookies, payload: {} })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/messages', cookies })).statusCode).toBe(401);
  });

  test('the sixth wrong login within the window returns 429, and the right passphrase is then refused too', async () => {
    await signIn();
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/api/login', payload: { passphrase: 'wrong wrong' } });
      expect(res.statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { passphrase: 'wrong wrong' } })).statusCode).toBe(429);
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { passphrase: PASS } })).statusCode).toBe(429);
    clock += 15 * 60 * 1000 + 1;
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { passphrase: PASS } })).statusCode).toBe(200);
  });

  test('an expired session is refused', async () => {
    const cookies = await signIn();
    clock += 181 * 24 * 60 * 60 * 1000;
    expect((await app.inject({ method: 'GET', url: '/api/messages', cookies })).statusCode).toBe(401);
  });

  test('a request from another site is refused', async () => {
    const cookies = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/api/send',
      cookies,
      headers: { origin: 'https://evil.example', host: 'parce.local' },
      payload: { english: 'x', spanish: 'y' },
    });
    expect(res.statusCode).toBe(403);
    expect(transport.sent).toHaveLength(0);
  });
});

describe('the sign-in gate cannot be sidestepped', () => {
  test('a percent-encoded spelling of an API path is still refused without a session', async () => {
    await signIn();
    transport.emitFromJuan('secreto');

    const get = await app.inject({ method: 'GET', url: '/%61pi/messages' });
    expect(get.statusCode).toBe(401);
    expect(get.body).not.toContain('secreto');

    const put = await app.inject({ method: 'PUT', url: '/%61pi/settings', payload: { juanNumber: '15550001111' } });
    expect(put.statusCode).toBe(401);
    expect(transport.chat).toBeNull();
    expect(store.getSetting('juan_number')).toBeNull();

    const post = await app.inject({ method: 'POST', url: '/%61pi/send', payload: { english: 'x', spanish: 'y' } });
    expect(post.statusCode).toBe(401);
    expect(transport.sent).toHaveLength(0);

    const upper = await app.inject({ method: 'GET', url: '/API/messages' });
    expect(upper.statusCode).not.toBe(200);
  });

  test('routes added by the demo mode sit behind the same gate', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/demo/ping' })).statusCode).toBe(401);
    const cookies = await signIn();
    const res = await app.inject({ method: 'POST', url: '/api/demo/ping', cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pong: true });
  });

  test('the cross-site check also covers an encoded path', async () => {
    const cookies = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/%61pi/send',
      cookies,
      headers: { origin: 'https://evil.example', host: 'parce.local' },
      payload: { english: 'x', spanish: 'y' },
    });
    expect(res.statusCode).toBe(403);
    expect(transport.sent).toHaveLength(0);
  });
});

describe('settings', () => {
  test('saving a key checks it, stores it, picks a model, and never echoes it back', async () => {
    const cookies = await signIn();
    const res = await app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: { anthropicApiKey: SECRET_KEY } });
    expect(res.statusCode).toBe(200);
    expect(store.getSetting('anthropic_api_key')).toBe(SECRET_KEY);
    expect(store.getSetting('model')).toBe('claude-opus-9');
    await app.inject({ method: 'GET', url: '/api/state', cookies });
    await app.inject({ method: 'GET', url: '/api/models', cookies });
    expect(bodies.length).toBeGreaterThan(2);
    for (const body of bodies) expect(body).not.toContain(SECRET_KEY);
  });

  test('a rejected key is not stored', async () => {
    const cookies = await signIn();
    keyAccepted = false;
    const res = await app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: { anthropicApiKey: SECRET_KEY } });
    expect(res.statusCode).toBe(400);
    expect(store.getSetting('anthropic_api_key')).toBeNull();
  });

  test('Juan’s number is reduced to digits and applied to the link', async () => {
    const cookies = await signIn();
    store.setSetting('juan_lid', '111@lid');
    const res = await app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: { juanNumber: '+57 300 123 4567' } });
    expect(res.statusCode).toBe(200);
    expect(transport.chat).toBe('573001234567');
    expect(store.getSetting('juan_number')).toBe('573001234567');
    expect(store.getSetting('juan_lid')).toBeNull();
  });

  test('a number that is too short is refused', async () => {
    const cookies = await signIn();
    const res = await app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: { juanNumber: '12345' } });
    expect(res.statusCode).toBe(400);
    expect(transport.chat).toBeNull();
  });

  test('state after sign-in reports settings without the key', async () => {
    const cookies = await signIn();
    await app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: { anthropicApiKey: SECRET_KEY, juanNumber: '573001234567', appendEnglish: true } });
    const state = (await app.inject({ method: 'GET', url: '/api/state', cookies })).json();
    expect(state).toMatchObject({
      configured: true,
      authed: true,
      hasKey: true,
      model: 'claude-opus-9',
      chatSet: true,
      previewBeforeSend: true,
      appendEnglish: true,
      link: { state: 'linked' },
    });
    expect(JSON.stringify(state)).not.toContain(SECRET_KEY);
  });

  test('models lists what the key can use and suggests one', async () => {
    const cookies = await signIn();
    expect((await app.inject({ method: 'GET', url: '/api/models', cookies })).statusCode).toBe(400);
    store.setSetting('anthropic_api_key', SECRET_KEY);
    const res = await app.inject({ method: 'GET', url: '/api/models', cookies });
    expect(res.json()).toEqual({
      models: [
        { id: 'claude-small-1', name: 'Small 1' },
        { id: 'claude-opus-9', name: 'Opus 9' },
      ],
      suggested: 'claude-opus-9',
    });
  });
});

describe('messages', () => {
  test('GET messages returns oldest first', async () => {
    const cookies = await signIn();
    transport.emitFromJuan('uno');
    clock += 5;
    transport.emitFromJuan('dos');
    const res = await app.inject({ method: 'GET', url: '/api/messages', cookies });
    expect(res.json().messages.map((m: { original: string }) => m.original)).toEqual(['uno', 'dos']);
  });

  test('GET messages pages back from a message id', async () => {
    const cookies = await signIn();
    transport.emitFromJuan('uno');
    transport.emitFromJuan('dos');
    transport.emitFromJuan('tres');
    const all = (await app.inject({ method: 'GET', url: '/api/messages', cookies })).json().messages as { id: string; original: string }[];
    const res = await app.inject({ method: 'GET', url: `/api/messages?before=${all[2]!.id}&limit=1`, cookies });
    expect(res.json().messages.map((m: { original: string }) => m.original)).toEqual(['dos']);
  });

  test('POST draft returns the Spanish and its literal reading', async () => {
    const cookies = await signIn();
    const res = await app.inject({ method: 'POST', url: '/api/draft', cookies, payload: { text: 'wait for me', tone: 'firmer' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ spanish: '[ES:firmer] wait for me', back: '[BACK] [ES:firmer] wait for me', notes: [], ambiguity: null });
  });

  test('POST draft refuses empty text and an unknown tone', async () => {
    const cookies = await signIn();
    expect((await app.inject({ method: 'POST', url: '/api/draft', cookies, payload: { text: '  ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/draft', cookies, payload: { text: 'x', tone: 'angry' } })).statusCode).toBe(400);
  });

  test('POST draft returns 502 with the reason when the translator fails', async () => {
    const cookies = await signIn();
    translator.failNext = true;
    const res = await app.inject({ method: 'POST', url: '/api/draft', cookies, payload: { text: 'wait for me' } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/told to fail/);
  });

  test('POST send stores and returns the message', async () => {
    const cookies = await signIn();
    const res = await app.inject({ method: 'POST', url: '/api/send', cookies, payload: { english: 'wait for me', spanish: 'esperame', back: 'wait for me' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ direction: 'out', original: 'wait for me', translation: 'esperame', status: 'sent' });
    expect(transport.sent).toEqual(['esperame']);
  });

  test('POST send returns 409 when the link is down', async () => {
    const cookies = await signIn();
    transport.setState('down');
    const res = await app.inject({ method: 'POST', url: '/api/send', cookies, payload: { english: 'wait for me', spanish: 'esperame' } });
    expect(res.statusCode).toBe(409);
    expect(transport.sent).toHaveLength(0);
  });

  test('POST send returns 502 when WhatsApp refuses the message', async () => {
    const cookies = await signIn();
    transport.failSend = true;
    const res = await app.inject({ method: 'POST', url: '/api/send', cookies, payload: { english: 'wait for me', spanish: 'esperame' } });
    expect(res.statusCode).toBe(502);
  });

  test('POST read marks messages and forwards the receipt', async () => {
    const cookies = await signIn();
    transport.emitRaw({ waId: 'R1', fromMe: false, ts: clock, kind: 'text', text: 'uno' });
    const id = store.listMessages({ limit: 1 })[0]!.id;
    const res = await app.inject({ method: 'POST', url: '/api/read', cookies, payload: { ids: [id] } });
    expect(res.statusCode).toBe(204);
    expect(transport.read).toEqual(['R1']);
  });

  test('an unknown API path returns 404 as JSON when signed in, and 401 otherwise', async () => {
    const cookies = await signIn();
    const res = await app.inject({ method: 'GET', url: '/api/nope', cookies });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty('error');
    expect((await app.inject({ method: 'GET', url: '/api/nope' })).statusCode).toBe(401);
  });
});

describe('shutting down', () => {
  test('closing the server ends open event streams instead of hanging', async () => {
    const cookies = await signIn();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/api/events`, { headers: { cookie: `parce_session=${cookies.parce_session}` } });
    const reader = res.body!.getReader();
    await reader.read();
    const outcome = await Promise.race([
      app.close().then(() => 'closed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 3000)),
    ]);
    expect(outcome).toBe('closed');
    await reader.cancel().catch(() => {});
  });
});

describe('live updates', () => {
  test('the event stream starts with the link status and then carries new messages', async () => {
    const cookies = await signIn();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    const res = await fetch(`${address}/api/events`, {
      headers: { cookie: `parce_session=${cookies.parce_session}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil('event: link');
    expect(text).toContain('"state":"linked"');
    transport.emitFromJuan('hola en vivo');
    await readUntil('hola en vivo');
    expect(text).toContain('event: message');
    controller.abort();
  });
});
