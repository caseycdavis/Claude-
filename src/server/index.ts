import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { ConversationService } from './conversation.js';
import { EventBus } from './events.js';
import { buildApp } from './http/app.js';
import { Store } from './store.js';
import { ClaudeTranslator, makeClient, type MessagesClient } from './translator/claude.js';
import { FakeTranslator } from './translator/fake.js';
import { FakeTransport } from './transport/fake.js';
import { WhatsAppTransport } from './transport/whatsapp.js';
import type { Translator, Transport } from './types.js';

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const dbFile = path.join(config.dataDir, 'parce.db');
  const store = new Store(dbFile);
  // The database holds the translation key and the messages. Keep it readable by this user only.
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
  }
  const bus = new EventBus();

  const authDir = path.join(config.dataDir, 'whatsapp');
  const transport: Transport = config.demo
    ? new FakeTransport()
    : new WhatsAppTransport({
        authDir,
        lid: store.getSetting('juan_lid'),
        onLid: (lid) => store.setSetting('juan_lid', lid),
        log,
      });
  transport.setChat(store.getSetting('juan_number'));

  // One provider client per key, rebuilt only when the key changes.
  let cached: { key: string; client: MessagesClient; translator: Translator } | null = null;
  const clientFor = (key: string): MessagesClient => {
    if (cached?.key !== key) {
      const client = makeClient(key);
      cached = { key, client, translator: new ClaudeTranslator({ client, model: () => store.getSetting('model') ?? '' }) };
    }
    return cached.client;
  };
  const demoTranslator = new FakeTranslator();
  const translator = (): Translator | null => {
    if (config.demo) return demoTranslator;
    const key = store.getSetting('anthropic_api_key');
    if (key === null) return null;
    clientFor(key);
    return cached!.translator;
  };

  const conversation = new ConversationService({ store, translator, transport, bus });
  conversation.start();

  const app = buildApp({ config, store, bus, transport, conversation, clientFor });
  if (config.demo) {
    const { registerDemoRoutes } = await import('./http/demo.js');
    registerDemoRoutes(app, transport as FakeTransport);
  }

  await app.listen({ port: config.port, host: config.host });
  log(`parce is listening on http://${config.host}:${config.port}${config.demo ? ' (demo mode, nothing is sent anywhere)' : ''}`);

  // Reconnect on boot only when this machine was linked before. A first link starts from the app's link screen.
  if (config.demo || fs.existsSync(path.join(authDir, 'creds.json'))) {
    transport.start().catch((e: unknown) => log(`whatsapp: start failed (${e instanceof Error ? e.message : String(e)})`));
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log('parce is shutting down');
    await transport.stop().catch(() => {});
    await app.close().catch(() => {});
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
