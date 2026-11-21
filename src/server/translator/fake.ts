import type { ContextLine, IncomingResult, OutgoingResult, Profile, Tone, Translator } from '../types.js';
import { TranslationError } from './claude.js';

/** A predictable stand-in used by the demo mode and the tests. It never leaves the machine. */
export class FakeTranslator implements Translator {
  /** When true, the next call fails once. */
  failNext = false;
  /** When set, every call waits for it before answering. */
  gate: Promise<void> | null = null;
  readonly calls = { incoming: 0, outgoing: 0, back: 0 };

  private async pass(): Promise<void> {
    if (this.gate) await this.gate;
    if (this.failNext) {
      this.failNext = false;
      throw new TranslationError('api', 'The stand-in translator was told to fail.');
    }
  }

  async incoming(i: { text: string; context: ContextLine[]; profile: Profile }): Promise<IncomingResult> {
    this.calls.incoming += 1;
    await this.pass();
    return { english: `[EN] ${i.text}`, notes: [], ambiguity: null };
  }

  async outgoing(i: { text: string; tone: Tone; context: ContextLine[]; profile: Profile }): Promise<OutgoingResult> {
    this.calls.outgoing += 1;
    await this.pass();
    return { spanish: `[ES:${i.tone}] ${i.text}`, notes: [], ambiguity: null };
  }

  async backTranslate(spanish: string): Promise<string> {
    this.calls.back += 1;
    await this.pass();
    return `[BACK] ${spanish}`;
  }
}
