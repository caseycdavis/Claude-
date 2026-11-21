import { randomUUID } from 'node:crypto';
import type { EventBus } from './events.js';
import type { Store } from './store.js';
import { TranslationError } from './translator/claude.js';
import { DEFAULT_INSTRUCTIONS, shouldSkip } from './translator/prompt.js';
import type { ContextLine, InboundMessage, Message, Note, Profile, Tone, Translator, Transport } from './types.js';

export class LinkDownError extends Error {
  override readonly name = 'LinkDownError';
  constructor() {
    super('WhatsApp is not linked right now. Your draft is kept.');
  }
}

/** How many earlier messages the translator sees for context. */
const CONTEXT_LIMIT = 30;

export type Preview = { spanish: string; back: string; notes: Note[]; ambiguity: string | null };

/** The only place where the store, the translator and the transport meet. */
export class ConversationService {
  private readonly pending = new Set<Promise<void>>();
  private sending = 0;
  /** Messages marked as "from me" that arrived while a send was in flight; they may be its echo. */
  private held: InboundMessage[] = [];
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      store: Store;
      translator: () => Translator | null;
      transport: Transport;
      bus: EventBus;
      now?: () => number;
    },
  ) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.deps.transport.subscribe((e) => {
      if (e.type === 'status') this.deps.bus.publish({ type: 'link', status: e.status });
      else this.onInbound(e.message);
    });
  }

  profile(): Profile {
    const { store } = this.deps;
    let glossary: Note[] = [];
    try {
      const raw: unknown = JSON.parse(store.getSetting('glossary') ?? '[]');
      if (Array.isArray(raw)) {
        glossary = raw.filter((g): g is Note => typeof g?.term === 'string' && typeof g?.meaning === 'string');
      }
    } catch {
      glossary = [];
    }
    return {
      instructions: store.getSetting('instructions') ?? DEFAULT_INSTRUCTIONS,
      aboutUs: store.getSetting('about_us') ?? '',
      glossary,
    };
  }

  /** Translates a draft and reads it back. Stores nothing and sends nothing. */
  async preview(text: string, tone: Tone): Promise<Preview> {
    const translator = this.requireTranslator();
    const out = await translator.outgoing({
      text,
      tone,
      context: this.deps.store.recentContext(CONTEXT_LIMIT),
      profile: this.profile(),
    });
    const back = await translator.backTranslate(out.spanish);
    return { spanish: out.spanish, back, notes: out.notes, ambiguity: out.ambiguity };
  }

  /** Sends now or fails now. Nothing is queued. */
  async send(input: { english: string; spanish: string; back?: string | null }): Promise<Message> {
    const spanish = input.spanish.trim();
    if (spanish === '') throw new Error('There is nothing to send.');
    const { store, transport, bus } = this.deps;
    if (transport.status().state !== 'linked') throw new LinkDownError();

    const body = store.getSetting('append_english') === '1' && input.english.trim() !== '' ? `${spanish}\n\n${input.english.trim()}` : spanish;

    this.sending += 1;
    let message: Message;
    try {
      const sent = await transport.sendText(body);
      message = {
        id: randomUUID(),
        waId: sent.waId,
        direction: 'out',
        source: 'app',
        kind: 'text',
        original: input.english,
        translation: spanish,
        backTranslation: input.back ?? null,
        notes: [],
        ambiguity: null,
        status: 'sent',
        ts: sent.ts,
        read: true,
      };
      store.insertMessage(message);
    } finally {
      this.sending -= 1;
      if (this.sending === 0) this.releaseHeld();
    }
    bus.publish({ type: 'message', message });
    return message;
  }

  /** Tries a failed translation again. Throws, leaving the row failed, if it fails again. */
  async retry(id: string): Promise<Message> {
    const { store, bus } = this.deps;
    const current = store.getMessage(id);
    if (!current) throw new Error('That message no longer exists.');
    if (current.direction !== 'in' || current.kind !== 'text' || current.status !== 'failed') return current;

    bus.publish({ type: 'message', message: store.updateMessage(id, { status: 'translating' }) });
    const context = store.recentContext(CONTEXT_LIMIT, current.ts);
    try {
      const translator = this.requireTranslator();
      const out = await translator.incoming({ text: current.original, context, profile: this.profile() });
      const done = store.updateMessage(id, { translation: out.english, notes: out.notes, ambiguity: out.ambiguity, status: 'done' });
      bus.publish({ type: 'message', message: done });
      return done;
    } catch (e) {
      bus.publish({ type: 'message', message: store.updateMessage(id, { status: 'failed' }) });
      throw e;
    }
  }

  async markRead(ids: string[]): Promise<void> {
    const waIds = this.deps.store.markRead(ids);
    if (waIds.length === 0) return;
    // A missed read receipt is not worth failing the request over.
    await this.deps.transport.markRead(waIds).catch(() => {});
  }

  /** Resolves when every translation started so far has finished. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private requireTranslator(): Translator {
    const translator = this.deps.translator();
    if (!translator) throw new TranslationError('auth', 'Add a translation key in settings first.');
    return translator;
  }

  private releaseHeld(): void {
    const held = this.held;
    this.held = [];
    for (const m of held) this.onInbound(m);
  }

  private onInbound(m: InboundMessage): void {
    const { store, bus } = this.deps;

    if (m.fromMe) {
      // While a send is in flight this may be its own echo; decide once the send has stored its row.
      if (this.sending > 0) {
        this.held.push(m);
        return;
      }
      const message: Message = {
        id: randomUUID(),
        waId: m.waId,
        direction: 'out',
        source: 'phone',
        kind: m.kind,
        original: m.text,
        translation: null,
        backTranslation: null,
        notes: [],
        ambiguity: null,
        status: 'sent',
        ts: m.ts,
        read: true,
      };
      if (store.insertMessage(message)) bus.publish({ type: 'message', message });
      return;
    }

    const translate = m.kind === 'text' && !shouldSkip(m.text);
    // Read the context before the message itself is stored, so it is not part of its own context.
    const context = translate ? store.recentContext(CONTEXT_LIMIT) : [];
    const message: Message = {
      id: randomUUID(),
      waId: m.waId,
      direction: 'in',
      source: 'juan',
      kind: m.kind,
      original: m.text,
      translation: null,
      backTranslation: null,
      notes: [],
      ambiguity: null,
      status: translate ? 'translating' : 'skipped',
      ts: m.ts,
      read: false,
    };
    // A repeated delivery of the same WhatsApp message stops here.
    if (!store.insertMessage(message)) return;
    bus.publish({ type: 'message', message });
    if (translate) this.track(this.translateIncoming(message.id, m.text, context));
  }

  private async translateIncoming(id: string, text: string, context: ContextLine[]): Promise<void> {
    const { store, bus } = this.deps;
    try {
      const translator = this.requireTranslator();
      const out = await translator.incoming({ text, context, profile: this.profile() });
      bus.publish({
        type: 'message',
        message: store.updateMessage(id, { translation: out.english, notes: out.notes, ambiguity: out.ambiguity, status: 'done' }),
      });
    } catch {
      bus.publish({ type: 'message', message: store.updateMessage(id, { status: 'failed' }) });
    }
  }

  private track(p: Promise<void>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }
}
