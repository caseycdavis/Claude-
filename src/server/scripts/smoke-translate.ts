/**
 * A live check of the translator, using the key and model saved by the app's setup screen.
 * It sends three invented lines to the provider, prints what came back, how long each call took
 * and what it cost in tokens, and exits non-zero if anything failed.
 *
 *   npm run build && npm run smoke:translate
 */
import path from 'node:path';
import { loadConfig } from '../config.js';
import { Store } from '../store.js';
import { ClaudeTranslator, makeClient, type MessagesClient } from '../translator/claude.js';
import { DEFAULT_INSTRUCTIONS } from '../translator/prompt.js';
import type { Profile } from '../types.js';

type Call = { via: 'structured' | 'plain'; ms: number; usage: Record<string, unknown> | null; failed: boolean };

function timed(client: MessagesClient, calls: Call[]): MessagesClient {
  const wrap = (via: Call['via'], fn: (args: any) => Promise<any>) => async (args: any) => {
    const started = Date.now();
    try {
      const res = await fn(args);
      calls.push({ via, ms: Date.now() - started, usage: res?.usage ?? null, failed: false });
      return res;
    } catch (e) {
      calls.push({ via, ms: Date.now() - started, usage: null, failed: true });
      throw e;
    }
  };
  return {
    messages: { parse: wrap('structured', client.messages.parse), create: wrap('plain', client.messages.create) },
    models: client.models,
  };
}

function report(label: string, calls: Call[]): void {
  for (const c of calls.splice(0)) {
    const u = c.usage ?? {};
    console.log(
      `  ${label}: ${c.via} request, ${c.failed ? 'FAILED' : 'ok'}, ${c.ms} ms, tokens in ${u.input_tokens ?? '?'} out ${u.output_tokens ?? '?'}` +
        ` (cache read ${u.cache_read_input_tokens ?? 0}, cache write ${u.cache_creation_input_tokens ?? 0})`,
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const store = new Store(path.join(config.dataDir, 'parce.db'));
  const key = store.getSetting('anthropic_api_key');
  const model = store.getSetting('model');
  if (!key || !model) {
    console.error('No key or model is saved yet. Finish the setup screen in the app first.');
    process.exit(1);
  }
  console.log(`Translator model: ${model}`);

  const calls: Call[] = [];
  const translator = new ClaudeTranslator({ client: timed(makeClient(key), calls), model: () => model });
  const profile: Profile = {
    instructions: store.getSetting('instructions') ?? DEFAULT_INSTRUCTIONS,
    aboutUs: store.getSetting('about_us') ?? '',
    glossary: [],
  };
  const context = [
    { speaker: 'Casey' as const, text: 'On my way' },
    { speaker: 'Juan' as const, text: 'Listo' },
  ];

  console.log('\n1. From Juan: "¿Ya saliste? Acá te espero, parce"');
  const incoming = await translator.incoming({ text: '¿Ya saliste? Acá te espero, parce', context, profile });
  report('incoming', calls);
  console.log(`  English:   ${incoming.english}`);
  console.log(`  Notes:     ${incoming.notes.map((n) => `${n.term} = ${n.meaning}`).join('; ') || '(none)'}`);
  console.log(`  Ambiguity: ${incoming.ambiguity ?? '(none)'}`);

  console.log('\n2. From Casey: "I might be late, wait for me"');
  const outgoing = await translator.outgoing({ text: 'I might be late, wait for me', tone: 'base', context, profile });
  report('outgoing', calls);
  console.log(`  Spanish:   ${outgoing.spanish}`);

  console.log('\n3. Literal reading of that Spanish, from a request that sees only the Spanish');
  const back = await translator.backTranslate(outgoing.spanish);
  report('reading', calls);
  console.log(`  Reads as:  ${back}`);

  console.log('\nAll three calls worked. If any line above says "plain request", the structured form was rejected and the fallback was used.');
  store.close();
}

main().catch((e: unknown) => {
  console.error(`\nThe translator check failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
