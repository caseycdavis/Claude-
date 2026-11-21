import { describe, expect, test } from 'vitest';
import { Store } from '../src/server/store.js';
import type { Message } from '../src/server/types.js';

function msg(over: Partial<Message> = {}): Message {
  return {
    id: over.id ?? `m-${Math.random().toString(36).slice(2)}`,
    waId: null,
    direction: 'in',
    source: 'juan',
    kind: 'text',
    original: 'hola',
    translation: null,
    backTranslation: null,
    notes: [],
    ambiguity: null,
    status: 'translating',
    ts: 1000,
    read: false,
    ...over,
  };
}

describe('Store', () => {
  test('settings round-trip and delete with null', () => {
    const s = new Store(':memory:');
    expect(s.getSetting('model')).toBeNull();
    s.setSetting('model', 'some-model');
    expect(s.getSetting('model')).toBe('some-model');
    s.setSetting('model', 'other');
    expect(s.getSetting('model')).toBe('other');
    s.setSetting('model', null);
    expect(s.getSetting('model')).toBeNull();
  });

  test('insertMessage returns false for a repeated waId and keeps one row', () => {
    const s = new Store(':memory:');
    expect(s.insertMessage(msg({ id: 'a', waId: 'W1' }))).toBe(true);
    expect(s.insertMessage(msg({ id: 'b', waId: 'W1', original: 'otra' }))).toBe(false);
    const all = s.listMessages({ limit: 10 });
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe('a');
    expect(all[0]!.original).toBe('hola');
  });

  test('messages without a waId never collide with each other', () => {
    const s = new Store(':memory:');
    expect(s.insertMessage(msg({ id: 'a', waId: null }))).toBe(true);
    expect(s.insertMessage(msg({ id: 'b', waId: null }))).toBe(true);
    expect(s.listMessages({ limit: 10 })).toHaveLength(2);
  });

  test('a message round-trips with its notes, ambiguity and flags', () => {
    const s = new Store(':memory:');
    const m = msg({
      id: 'a',
      waId: 'W9',
      direction: 'out',
      source: 'app',
      original: 'wait for me',
      translation: 'esperame',
      backTranslation: 'wait for me',
      notes: [{ term: 'parce', meaning: 'buddy' }],
      ambiguity: 'two readings',
      status: 'sent',
      ts: 42,
      read: true,
    });
    s.insertMessage(m);
    expect(s.getMessage('a')).toEqual(m);
    expect(s.getMessage('missing')).toBeNull();
  });

  test('updateMessage changes only the patched fields and returns the row', () => {
    const s = new Store(':memory:');
    s.insertMessage(msg({ id: 'a', original: 'hola' }));
    const out = s.updateMessage('a', { translation: 'hello', status: 'done', notes: [{ term: 'x', meaning: 'y' }] });
    expect(out.translation).toBe('hello');
    expect(out.status).toBe('done');
    expect(out.notes).toEqual([{ term: 'x', meaning: 'y' }]);
    expect(out.original).toBe('hola');
    expect(() => s.updateMessage('missing', { status: 'done' })).toThrow();
  });

  test('listMessages returns oldest first and pages back from a message', () => {
    const s = new Store(':memory:');
    for (const ts of [10, 20, 30, 40]) s.insertMessage(msg({ id: `m${ts}`, ts }));
    expect(s.listMessages({ limit: 10 }).map((m) => m.ts)).toEqual([10, 20, 30, 40]);
    expect(s.listMessages({ limit: 2 }).map((m) => m.ts)).toEqual([30, 40]);
    expect(s.listMessages({ beforeId: 'm30', limit: 10 }).map((m) => m.ts)).toEqual([10, 20]);
    expect(s.listMessages({ beforeId: 'm40', limit: 1 }).map((m) => m.ts)).toEqual([30]);
    expect(s.listMessages({ beforeId: 'missing', limit: 10 })).toEqual([]);
  });

  test('paging back does not skip messages that share a timestamp', () => {
    const s = new Store(':memory:');
    for (const id of ['a', 'b', 'c', 'd', 'e']) s.insertMessage(msg({ id, ts: 5000 }));
    const lastPage = s.listMessages({ limit: 2 }).map((m) => m.id);
    expect(lastPage).toEqual(['d', 'e']);
    const middle = s.listMessages({ beforeId: 'd', limit: 2 }).map((m) => m.id);
    expect(middle).toEqual(['b', 'c']);
    expect(s.listMessages({ beforeId: 'b', limit: 2 }).map((m) => m.id)).toEqual(['a']);
  });

  test('failStaleTranslations turns rows left on translating into failed ones', () => {
    const s = new Store(':memory:');
    s.insertMessage(msg({ id: 'a', status: 'translating' }));
    s.insertMessage(msg({ id: 'b', status: 'done', translation: 'x' }));
    expect(s.failStaleTranslations()).toBe(1);
    expect(s.getMessage('a')!.status).toBe('failed');
    expect(s.getMessage('b')!.status).toBe('done');
    expect(s.failStaleTranslations()).toBe(0);
  });

  test('a message can be found by its WhatsApp id', () => {
    const s = new Store(':memory:');
    s.insertMessage(msg({ id: 'a', waId: 'W1' }));
    expect(s.getMessageByWaId('W1')!.id).toBe('a');
    expect(s.getMessageByWaId('nope')).toBeNull();
  });

  test('the exact text of a sent message is kept by its WhatsApp id', () => {
    const s = new Store(':memory:');
    expect(s.getSentBody('W1')).toBeNull();
    s.saveSentBody('W1', 'esperame\n\nwait for me');
    expect(s.getSentBody('W1')).toBe('esperame\n\nwait for me');
  });

  test('recentContext labels in as Juan and out as Casey and skips kind other', () => {
    const s = new Store(':memory:');
    s.insertMessage(msg({ id: 'a', ts: 1, direction: 'in', original: 'hola' }));
    s.insertMessage(msg({ id: 'b', ts: 2, direction: 'out', source: 'app', original: 'hi', translation: 'hola' }));
    s.insertMessage(msg({ id: 'c', ts: 3, direction: 'in', kind: 'other', original: 'Voice note' }));
    s.insertMessage(msg({ id: 'd', ts: 4, direction: 'in', original: 'listo' }));
    expect(s.recentContext(10)).toEqual([
      { speaker: 'Juan', text: 'hola' },
      { speaker: 'Casey', text: 'hi' },
      { speaker: 'Juan', text: 'listo' },
    ]);
    expect(s.recentContext(1)).toEqual([{ speaker: 'Juan', text: 'listo' }]);
  });

  test('recentContext with a before time returns only older messages', () => {
    const s = new Store(':memory:');
    s.insertMessage(msg({ id: 'a', ts: 1, original: 'uno' }));
    s.insertMessage(msg({ id: 'b', ts: 2, original: 'dos' }));
    s.insertMessage(msg({ id: 'c', ts: 3, original: 'tres' }));
    expect(s.recentContext(10, 3).map((c) => c.text)).toEqual(['uno', 'dos']);
    expect(s.recentContext(10, 1)).toEqual([]);
  });

  test('markRead returns only newly marked waIds', () => {
    const s = new Store(':memory:');
    s.insertMessage(msg({ id: 'a', waId: 'W1' }));
    s.insertMessage(msg({ id: 'b', waId: 'W2' }));
    s.insertMessage(msg({ id: 'c', waId: null }));
    expect(s.markRead(['a', 'c']).sort()).toEqual(['W1']);
    expect(s.markRead(['a', 'b'])).toEqual(['W2']);
    expect(s.getMessage('a')!.read).toBe(true);
    expect(s.markRead([])).toEqual([]);
  });

  test('session expires at its expiry time', () => {
    const s = new Store(':memory:');
    s.createSession('hash1', 5000);
    expect(s.hasSession('hash1', 4999)).toBe(true);
    expect(s.hasSession('hash1', 5000)).toBe(false);
    expect(s.hasSession('nope', 1)).toBe(false);
    s.createSession('hash2', 9000);
    s.deleteSession('hash2');
    expect(s.hasSession('hash2', 1)).toBe(false);
  });
});
