import { beforeEach, describe, expect, test } from 'vitest';
import { ConversationService, LinkDownError } from '../src/server/conversation.js';
import { EventBus, type AppEvent } from '../src/server/events.js';
import { Store } from '../src/server/store.js';
import { FakeTranslator } from '../src/server/translator/fake.js';
import { FakeTransport } from '../src/server/transport/fake.js';
import type { Translator } from '../src/server/types.js';

let store: Store;
let translator: FakeTranslator;
let transport: FakeTransport;
let bus: EventBus;
let events: AppEvent[];
let svc: ConversationService;
let clock: number;
let configured: Translator | null;

function messageEvents() {
  return events.filter((e): e is Extract<AppEvent, { type: 'message' }> => e.type === 'message').map((e) => e.message);
}

beforeEach(() => {
  clock = 1_000;
  store = new Store(':memory:');
  translator = new FakeTranslator();
  configured = translator;
  transport = new FakeTransport(() => clock);
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  svc = new ConversationService({ store, translator: () => configured, transport, bus, now: () => clock });
  svc.start();
});

describe('incoming', () => {
  test('a message is stored and published as translating before the translator answers, then becomes done', async () => {
    let release!: () => void;
    translator.gate = new Promise<void>((r) => (release = r));
    transport.emitFromJuan('hola parce');

    const first = messageEvents();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ direction: 'in', source: 'juan', original: 'hola parce', translation: null, status: 'translating' });
    expect(store.listMessages({ limit: 10 })[0]!.status).toBe('translating');

    release();
    await svc.settled();
    const last = messageEvents().at(-1)!;
    expect(last).toMatchObject({ id: first[0]!.id, status: 'done', translation: '[EN] hola parce', original: 'hola parce' });
    expect(store.getMessage(first[0]!.id)!.status).toBe('done');
  });

  test('the message being translated is not part of its own context', async () => {
    const seen: string[][] = [];
    configured = {
      incoming: async (i) => {
        seen.push(i.context.map((c) => c.text));
        return { english: 'x', notes: [], ambiguity: null };
      },
      outgoing: async () => ({ spanish: 'x', notes: [], ambiguity: null }),
      backTranslate: async () => 'x',
    };
    transport.emitFromJuan('uno');
    await svc.settled();
    clock += 10;
    transport.emitFromJuan('dos');
    await svc.settled();
    expect(seen).toEqual([[], ['uno']]);
  });

  test('a message with nothing to translate is stored as skipped with no translator call', async () => {
    transport.emitFromJuan('😂');
    await svc.settled();
    expect(store.listMessages({ limit: 10 })[0]).toMatchObject({ status: 'skipped', translation: null });
    expect(translator.calls.incoming).toBe(0);
  });

  test('a kind the app cannot show is stored as skipped with no translator call', async () => {
    transport.emitRaw({ waId: 'V1', fromMe: false, ts: clock, kind: 'other', text: 'Voice note' });
    await svc.settled();
    expect(store.listMessages({ limit: 10 })[0]).toMatchObject({ kind: 'other', original: 'Voice note', status: 'skipped' });
    expect(translator.calls.incoming).toBe(0);
  });

  test('a message Casey sent from his phone is stored as out, source phone, with no translator call', async () => {
    transport.emitFromPhone('sent from WhatsApp');
    await svc.settled();
    expect(store.listMessages({ limit: 10 })[0]).toMatchObject({
      direction: 'out',
      source: 'phone',
      original: 'sent from WhatsApp',
      status: 'sent',
      read: true,
    });
    expect(translator.calls.incoming + translator.calls.outgoing + translator.calls.back).toBe(0);
  });

  // Review Focus 3
  test('when the translator fails the row is failed with the original intact, and retry turns it to done', async () => {
    translator.failNext = true;
    transport.emitFromJuan('nos vemos');
    await svc.settled();
    const row = store.listMessages({ limit: 10 })[0]!;
    expect(row).toMatchObject({ status: 'failed', original: 'nos vemos', translation: null });

    const fixed = await svc.retry(row.id);
    expect(fixed).toMatchObject({ status: 'done', translation: '[EN] nos vemos' });
    expect(messageEvents().at(-1)).toMatchObject({ id: row.id, status: 'done' });
  });

  test('a retry that fails again leaves the row failed and reports why', async () => {
    translator.failNext = true;
    transport.emitFromJuan('nos vemos');
    await svc.settled();
    const row = store.listMessages({ limit: 10 })[0]!;
    translator.failNext = true;
    await expect(svc.retry(row.id)).rejects.toThrow(/told to fail/);
    expect(store.getMessage(row.id)!.status).toBe('failed');
  });

  test('with no translator configured an incoming message is stored as failed and can be retried later', async () => {
    configured = null;
    transport.emitFromJuan('hola');
    await svc.settled();
    const row = store.listMessages({ limit: 10 })[0]!;
    expect(row.status).toBe('failed');
    configured = translator;
    expect((await svc.retry(row.id)).status).toBe('done');
  });

  // Review Focus 5
  test('the same incoming message delivered twice is stored once and translated once', async () => {
    const m = { waId: 'DUP1', fromMe: false, ts: clock, kind: 'text' as const, text: 'hola' };
    transport.emitRaw(m);
    transport.emitRaw(m);
    await svc.settled();
    expect(store.listMessages({ limit: 10 })).toHaveLength(1);
    expect(translator.calls.incoming).toBe(1);
  });
});

describe('preview', () => {
  test('returns the Spanish and an independent literal reading', async () => {
    const p = await svc.preview('wait for me', 'warmer');
    expect(p).toEqual({ spanish: '[ES:warmer] wait for me', back: '[BACK] [ES:warmer] wait for me', notes: [], ambiguity: null });
    expect(store.listMessages({ limit: 10 })).toHaveLength(0);
    expect(transport.sent).toHaveLength(0);
  });

  // Review Focus 3
  test('rejects when the translator fails, and nothing is sent', async () => {
    translator.failNext = true;
    await expect(svc.preview('wait for me', 'base')).rejects.toThrow();
    expect(transport.sent).toHaveLength(0);
    expect(store.listMessages({ limit: 10 })).toHaveLength(0);
  });

  test('rejects with a clear message when no translator is configured', async () => {
    configured = null;
    await expect(svc.preview('wait for me', 'base')).rejects.toThrow(/key/i);
  });
});

describe('send', () => {
  test('sends the Spanish and stores the pair as one outgoing message', async () => {
    const m = await svc.send({ english: 'wait for me', spanish: 'esperame', back: 'wait for me' });
    expect(transport.sent).toEqual(['esperame']);
    expect(m).toMatchObject({
      direction: 'out',
      source: 'app',
      original: 'wait for me',
      translation: 'esperame',
      backTranslation: 'wait for me',
      status: 'sent',
      read: true,
    });
    expect(m.waId).toBeTruthy();
    expect(store.getMessage(m.id)).toEqual(m);
    expect(messageEvents().at(-1)).toEqual(m);
  });

  test('with append English on, sends the Spanish, a blank line, then the English', async () => {
    store.setSetting('append_english', '1');
    await svc.send({ english: 'wait for me', spanish: 'esperame' });
    expect(transport.sent).toEqual(['esperame\n\nwait for me']);
  });

  test('refuses an empty Spanish text', async () => {
    await expect(svc.send({ english: 'x', spanish: '   ' })).rejects.toThrow();
    expect(transport.sent).toHaveLength(0);
  });

  // Review Focus 4
  test('throws LinkDownError when the link is not linked and leaves no row', async () => {
    transport.setState('down');
    await expect(svc.send({ english: 'wait for me', spanish: 'esperame' })).rejects.toBeInstanceOf(LinkDownError);
    expect(store.listMessages({ limit: 10 })).toHaveLength(0);
    expect(transport.sent).toHaveLength(0);
  });

  // Review Focus 4
  test('when the transport fails, send rejects, no row is stored, and nothing goes out after the link returns', async () => {
    transport.failSend = true;
    await expect(svc.send({ english: 'wait for me', spanish: 'esperame' })).rejects.toThrow();
    expect(store.listMessages({ limit: 10 })).toHaveLength(0);

    transport.failSend = false;
    transport.setState('down');
    transport.setState('linked');
    await svc.settled();
    expect(transport.sent).toHaveLength(0);
    expect(store.listMessages({ limit: 10 })).toHaveLength(0);
  });

  // Review Focus 5
  test('the echo of an app-sent message arriving afterwards creates no second row and no translator call', async () => {
    const m = await svc.send({ english: 'wait for me', spanish: 'esperame' });
    transport.emitRaw({ waId: m.waId!, fromMe: true, ts: clock, kind: 'text', text: 'esperame' });
    await svc.settled();
    const rows = store.listMessages({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'app', original: 'wait for me', translation: 'esperame' });
    expect(translator.calls.incoming).toBe(0);
  });

  // Review Focus 5
  test('an echo that arrives while the send is still in flight creates no second row either', async () => {
    transport.echoOnSend = true;
    const m = await svc.send({ english: 'wait for me', spanish: 'esperame' });
    await svc.settled();
    const rows = store.listMessages({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: m.id, source: 'app', original: 'wait for me', translation: 'esperame' });
  });

  test('a phone-sent message that arrives during an app send is still kept', async () => {
    transport.onSend = () => transport.emitFromPhone('typed on the phone');
    await svc.send({ english: 'wait for me', spanish: 'esperame' });
    await svc.settled();
    expect(store.listMessages({ limit: 10 }).map((r) => r.source).sort()).toEqual(['app', 'phone']);
  });
});

describe('markRead', () => {
  test('forwards only newly read WhatsApp ids to the transport', async () => {
    transport.emitRaw({ waId: 'R1', fromMe: false, ts: clock, kind: 'text', text: 'uno' });
    transport.emitRaw({ waId: 'R2', fromMe: false, ts: clock + 1, kind: 'text', text: 'dos' });
    await svc.settled();
    const [a, b] = store.listMessages({ limit: 10 });
    await svc.markRead([a!.id]);
    await svc.markRead([a!.id, b!.id]);
    expect(transport.read).toEqual(['R1', 'R2']);
  });
});

describe('link status', () => {
  test('is published on the bus when the transport reports a change', () => {
    transport.setState('down');
    const link = events.filter((e) => e.type === 'link').at(-1);
    expect(link).toMatchObject({ type: 'link', status: { state: 'down' } });
  });
});

describe('profile', () => {
  test('falls back to the default instructions and reads saved settings', () => {
    expect(svc.profile().instructions).toContain('Medellín');
    expect(svc.profile().glossary).toEqual([]);
    store.setSetting('instructions', 'CUSTOM');
    store.setSetting('about_us', 'ABOUT');
    store.setSetting('glossary', JSON.stringify([{ term: 'parce', meaning: 'buddy' }]));
    expect(svc.profile()).toEqual({ instructions: 'CUSTOM', aboutUs: 'ABOUT', glossary: [{ term: 'parce', meaning: 'buddy' }] });
    store.setSetting('glossary', 'not json');
    expect(svc.profile().glossary).toEqual([]);
  });
});
