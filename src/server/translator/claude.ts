import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import type { ContextLine, IncomingResult, Note, OutgoingResult, Profile, Tone, Translator } from '../types.js';
import {
  BACK_SHAPE,
  BACK_SYSTEM,
  BackSchema,
  INCOMING_SHAPE,
  IncomingSchema,
  OUTGOING_SHAPE,
  OutgoingSchema,
  backUser,
  incomingUser,
  outgoingUser,
  systemPrompt,
} from './prompt.js';

/** The part of the provider's client this program uses. Small so tests can stand in for it. */
export type MessagesClient = {
  messages: { parse(args: any): Promise<any>; create(args: any): Promise<any> };
  models: { list(): AsyncIterable<{ id: string; display_name: string; created_at: string }> };
};

export type TranslationFailure = 'auth' | 'refused' | 'empty' | 'rate' | 'api';

export class TranslationError extends Error {
  override readonly name = 'TranslationError';
  constructor(
    public readonly reason: TranslationFailure,
    message: string,
  ) {
    super(message);
  }
}

export function makeClient(apiKey: string): MessagesClient {
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
  return {
    messages: {
      parse: (args) => client.messages.parse(args),
      create: (args) => client.messages.create(args),
    },
    models: { list: () => client.models.list() },
  };
}

function mapError(e: unknown): TranslationError {
  if (e instanceof TranslationError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new TranslationError('auth', 'The translation key was rejected. Check the key in settings.');
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new TranslationError('rate', 'The translator is rate limited right now. Try again in a moment.');
  }
  if (e instanceof Anthropic.APIError) return new TranslationError('api', e.message);
  return new TranslationError('api', e instanceof Error ? e.message : String(e));
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

function cleanNotes(notes: Note[]): Note[] {
  return notes.filter((n) => n.term.trim() !== '' && n.meaning.trim() !== '').slice(0, 3);
}

function cleanAmbiguity(a: string | null): string | null {
  return a === null || a.trim() === '' ? null : a.trim();
}

export class ClaudeTranslator implements Translator {
  constructor(private readonly deps: { client: MessagesClient; model: () => string }) {}

  async incoming(i: { text: string; context: ContextLine[]; profile: Profile }): Promise<IncomingResult> {
    const out = await this.ask(IncomingSchema, INCOMING_SHAPE, systemPrompt(i.profile), incomingUser(i.text, i.context));
    if (out.english.trim() === '') throw new TranslationError('empty', 'The translator returned nothing.');
    return { english: out.english.trim(), notes: cleanNotes(out.notes), ambiguity: cleanAmbiguity(out.ambiguity) };
  }

  async outgoing(i: { text: string; tone: Tone; context: ContextLine[]; profile: Profile }): Promise<OutgoingResult> {
    const out = await this.ask(
      OutgoingSchema,
      OUTGOING_SHAPE,
      systemPrompt(i.profile),
      outgoingUser(i.text, i.tone, i.context),
    );
    if (out.spanish.trim() === '') throw new TranslationError('empty', 'The translator returned nothing.');
    return { spanish: out.spanish.trim(), notes: cleanNotes(out.notes), ambiguity: cleanAmbiguity(out.ambiguity) };
  }

  async backTranslate(spanish: string): Promise<string> {
    const out = await this.ask(BackSchema, BACK_SHAPE, BACK_SYSTEM, backUser(spanish));
    if (out.english.trim() === '') throw new TranslationError('empty', 'The translator returned nothing.');
    return out.english.trim();
  }

  private async ask<S extends z.ZodType>(schema: S, shape: string, system: string, user: string): Promise<z.infer<S>> {
    const model = this.deps.model();
    if (!model) throw new TranslationError('api', 'No translator model has been chosen yet.');
    const base = {
      model,
      max_tokens: 16000,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    };

    let res: any;
    try {
      res = await this.deps.client.messages.parse({
        ...base,
        messages: [{ role: 'user', content: user }],
        output_config: { format: zodOutputFormat(schema) },
      });
    } catch (e) {
      // A 400 may mean this model or account does not take a schema. Ask again in words.
      if (e instanceof Anthropic.BadRequestError) return this.askPlain(schema, shape, base, user);
      throw mapError(e);
    }
    if (res?.stop_reason === 'refusal') throw new TranslationError('refused', 'The translator declined this message.');
    if (res?.parsed_output === null || res?.parsed_output === undefined) {
      throw new TranslationError('empty', 'The translator returned nothing usable.');
    }
    return res.parsed_output as z.infer<S>;
  }

  private async askPlain<S extends z.ZodType>(schema: S, shape: string, base: object, user: string): Promise<z.infer<S>> {
    let res: any;
    try {
      res = await this.deps.client.messages.create({
        ...base,
        messages: [
          { role: 'user', content: `${user}\n\nReply with only a JSON object of this shape and nothing else:\n${shape}` },
        ],
      });
    } catch (e) {
      throw mapError(e);
    }
    if (res?.stop_reason === 'refusal') throw new TranslationError('refused', 'The translator declined this message.');
    const text = textOf(res?.content);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new TranslationError('empty', 'The translator returned nothing usable.');
    let raw: unknown;
    try {
      raw = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new TranslationError('empty', 'The translator returned nothing usable.');
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new TranslationError('empty', 'The translator returned nothing usable.');
    return parsed.data;
  }
}

/** Every model the key can use, newest first. */
export async function listModels(client: MessagesClient): Promise<{ id: string; name: string }[]> {
  const all: { id: string; name: string; created: number }[] = [];
  try {
    for await (const m of client.models.list()) {
      all.push({ id: m.id, name: m.display_name || m.id, created: Date.parse(m.created_at) || 0 });
    }
  } catch (e) {
    throw mapError(e);
  }
  all.sort((a, b) => b.created - a.created);
  return all.map(({ id, name }) => ({ id, name }));
}

/** The newest top-tier model when there is one, otherwise the newest of any kind. */
export function pickDefaultModel(models: { id: string; name: string }[]): string | null {
  const top = models.find((m) => m.id.startsWith('claude-opus'));
  return top?.id ?? models[0]?.id ?? null;
}
