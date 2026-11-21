import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, test } from 'vitest';
import {
  ClaudeTranslator,
  TranslationError,
  listModels,
  pickDefaultModel,
  type MessagesClient,
} from '../src/server/translator/claude.js';
import { DEFAULT_INSTRUCTIONS } from '../src/server/translator/prompt.js';
import type { Profile } from '../src/server/types.js';

const profile: Profile = { instructions: DEFAULT_INSTRUCTIONS, aboutUs: 'ABOUT-US-TEXT', glossary: [] };

type Call = { via: 'parse' | 'create'; args: any };

function stub(opts: {
  parse?: (args: any, n: number) => any;
  create?: (args: any, n: number) => any;
  models?: { id: string; display_name: string; created_at: string }[];
}): { client: MessagesClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: MessagesClient = {
    messages: {
      async parse(args: any) {
        calls.push({ via: 'parse', args });
        if (!opts.parse) throw new Error('parse not stubbed');
        return opts.parse(args, calls.length);
      },
      async create(args: any) {
        calls.push({ via: 'create', args });
        if (!opts.create) throw new Error('create not stubbed');
        return opts.create(args, calls.length);
      },
    },
    models: {
      list() {
        const items = opts.models ?? [];
        return (async function* () {
          for (const m of items) yield m;
        })();
      },
    },
  };
  return { client, calls };
}

const ok = (parsed: unknown) => ({ stop_reason: 'end_turn', parsed_output: parsed, content: [] });

describe('ClaudeTranslator', () => {
  test('incoming sends the configured model, a cached system block and a schema, and returns the parsed result', async () => {
    const { client, calls } = stub({
      parse: () => ok({ english: 'Hello there', notes: [{ term: 'parce', meaning: 'buddy' }], ambiguity: null }),
    });
    const t = new ClaudeTranslator({ client, model: () => 'MODEL-X' });
    const out = await t.incoming({ text: 'Hola parce', context: [{ speaker: 'Casey', text: 'CTX' }], profile });
    expect(out).toEqual({ english: 'Hello there', notes: [{ term: 'parce', meaning: 'buddy' }], ambiguity: null });
    expect(calls).toHaveLength(1);
    const a = calls[0]!.args;
    expect(a.model).toBe('MODEL-X');
    expect(a.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(a.system[0].text).toContain('ABOUT-US-TEXT');
    expect(a.output_config.format).toBeTruthy();
    expect(a.messages).toHaveLength(1);
    expect(a.messages[0].role).toBe('user');
    expect(a.messages[0].content).toContain('Hola parce');
    expect(a.messages[0].content).toContain('Casey: CTX');
    expect(a.thinking).toBeUndefined();
    expect(a.temperature).toBeUndefined();
  });

  test('outgoing returns the Spanish and passes the tone', async () => {
    const { client, calls } = stub({ parse: () => ok({ spanish: 'Esperame', notes: [], ambiguity: null }) });
    const t = new ClaudeTranslator({ client, model: () => 'MODEL-X' });
    const out = await t.outgoing({ text: 'Wait for me', tone: 'warmer', context: [], profile });
    expect(out.spanish).toBe('Esperame');
    expect(calls[0]!.args.messages[0].content.toLowerCase()).toContain('warmer');
  });

  test('the literal reading is a separate call that never sees the English or the profile', async () => {
    const { client, calls } = stub({
      parse: (_args, n) => (n === 1 ? ok({ spanish: 'Esperame', notes: [], ambiguity: null }) : ok({ english: 'Wait for me' })),
    });
    const t = new ClaudeTranslator({ client, model: () => 'MODEL-X' });
    const o = await t.outgoing({ text: 'ENGLISH-SOURCE-TEXT', tone: 'base', context: [], profile });
    const back = await t.backTranslate(o.spanish);
    expect(back).toBe('Wait for me');
    expect(calls).toHaveLength(2);
    const second = JSON.stringify(calls[1]!.args);
    expect(second).toContain('Esperame');
    expect(second).not.toContain('ENGLISH-SOURCE-TEXT');
    expect(second).not.toContain('ABOUT-US-TEXT');
  });

  test('a refusal throws TranslationError refused', async () => {
    const { client } = stub({ parse: () => ({ stop_reason: 'refusal', parsed_output: null, content: [] }) });
    const t = new ClaudeTranslator({ client, model: () => 'MODEL-X' });
    await expect(t.incoming({ text: 'hola', context: [], profile })).rejects.toMatchObject({
      name: 'TranslationError',
      reason: 'refused',
    });
  });

  test('a null parsed_output throws TranslationError empty', async () => {
    const { client } = stub({ parse: () => ok(null) });
    const t = new ClaudeTranslator({ client, model: () => 'MODEL-X' });
    await expect(t.incoming({ text: 'hola', context: [], profile })).rejects.toMatchObject({ reason: 'empty' });
  });

  test('a blank translation throws TranslationError empty', async () => {
    const { client } = stub({ parse: () => ok({ english: '   ', notes: [], ambiguity: null }) });
    const t = new ClaudeTranslator({ client, model: () => 'MODEL-X' });
    await expect(t.incoming({ text: 'hola', context: [], profile })).rejects.toMatchObject({ reason: 'empty' });
  });

  test('a rejected key throws TranslationError auth', async () => {
    const { client } = stub({
      parse: () => {
        throw new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers());
      },
    });
    const t = new ClaudeTranslator({ client, model: () => 'MODEL-X' });
    await expect(t.incoming({ text: 'hola', context: [], profile })).rejects.toMatchObject({ reason: 'auth' });
  });

  test('a rate limit throws TranslationError rate', async () => {
    const { client } = stub({
      parse: () => {
        throw new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers());
      },
    });
    const t = new ClaudeTranslator({ client, model: () => 'MODEL-X' });
    await expect(t.incoming({ text: 'hola', context: [], profile })).rejects.toMatchObject({ reason: 'rate' });
  });

  test('when the provider rejects the structured request, it falls back to plain JSON and still returns a result', async () => {
    const { client, calls } = stub({
      parse: () => {
        throw new Anthropic.BadRequestError(400, undefined, 'output_config: unsupported', new Headers());
      },
      create: () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Here you go:\n{"english":"Hello","notes":[],"ambiguity":null}' }],
      }),
    });
    const t = new ClaudeTranslator({ client, model: () => 'MODEL-X' });
    const out = await t.incoming({ text: 'hola', context: [], profile });
    expect(out.english).toBe('Hello');
    expect(calls.map((c) => c.via)).toEqual(['parse', 'create']);
    expect(calls[1]!.args.output_config).toBeUndefined();
  });

  test('when both the structured and the plain request are rejected, the provider message is kept', async () => {
    const boom = () => {
      throw new Anthropic.BadRequestError(400, undefined, 'Your credit balance is too low', new Headers());
    };
    const { client } = stub({ parse: boom, create: boom });
    const t = new ClaudeTranslator({ client, model: () => 'MODEL-X' });
    const err = await t.incoming({ text: 'hola', context: [], profile }).catch((e) => e);
    expect(err).toBeInstanceOf(TranslationError);
    expect(err.reason).toBe('api');
    expect(err.message).toContain('credit balance is too low');
  });

  test('with no model chosen it fails without calling the provider', async () => {
    const { client, calls } = stub({ parse: () => ok({ english: 'x', notes: [], ambiguity: null }) });
    const t = new ClaudeTranslator({ client, model: () => '' });
    await expect(t.incoming({ text: 'hola', context: [], profile })).rejects.toBeInstanceOf(TranslationError);
    expect(calls).toHaveLength(0);
  });
});

describe('models', () => {
  const models = [
    { id: 'claude-small-9', display_name: 'Small 9', created_at: '2026-09-01T00:00:00Z' },
    { id: 'claude-opus-7', display_name: 'Opus 7', created_at: '2026-03-01T00:00:00Z' },
    { id: 'claude-opus-8', display_name: 'Opus 8', created_at: '2026-06-01T00:00:00Z' },
  ];

  test('listModels returns id and name, newest first', async () => {
    const { client } = stub({ models });
    expect(await listModels(client)).toEqual([
      { id: 'claude-small-9', name: 'Small 9' },
      { id: 'claude-opus-8', name: 'Opus 8' },
      { id: 'claude-opus-7', name: 'Opus 7' },
    ]);
  });

  test('pickDefaultModel prefers the newest id starting claude-opus', async () => {
    const { client } = stub({ models });
    expect(pickDefaultModel(await listModels(client))).toBe('claude-opus-8');
  });

  test('pickDefaultModel falls back to the newest model, and to null for an empty list', () => {
    expect(pickDefaultModel([{ id: 'claude-small-9', name: 'Small 9' }])).toBe('claude-small-9');
    expect(pickDefaultModel([])).toBeNull();
  });
});
