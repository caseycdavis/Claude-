import fs from 'node:fs/promises';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WASocket } from 'baileys';
import QRCode from 'qrcode';
import type { LinkState, LinkStatus, Transport, TransportEvent } from '../types.js';
import { isUserJid, learnLid, matchesChat, phoneJid, toInbound, type ChatMatcher, type KeyLike } from './wa-map.js';

type Options = {
  /** Folder holding the WhatsApp session. Whoever has it has the whole account. */
  authDir: string;
  /** WhatsApp's opaque id for the allowed chat, when already learned. */
  lid?: string | null;
  onLid?: (lid: string) => void;
  log?: (line: string) => void;
};

type Logger = {
  level: string;
  child(obj: Record<string, unknown>): Logger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
};

/** Passes the library's warnings and errors on, and drops the rest. Message content is never logged. */
function quietLogger(log: (line: string) => void): Logger {
  const say = (level: string) => (obj: unknown, msg?: string) => {
    const text = typeof obj === 'string' ? obj : (msg ?? '');
    if (text) log(`whatsapp ${level}: ${text}`);
  };
  const logger: Logger = {
    level: 'warn',
    child: () => logger,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: say('warning'),
    error: say('error'),
  };
  return logger;
}

const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;
/** How many times a fresh linking code is fetched before waiting for the user to ask again. */
const MAX_CODE_REFRESHES = 3;
const REMEMBERED_KEYS = 500;

export class WhatsAppTransport implements Transport {
  private sock: WASocket | null = null;
  private readonly handlers: ((e: TransportEvent) => void)[] = [];
  private current: LinkStatus = { state: 'unlinked', qr: null, pairingCode: null, since: Date.now() };
  private matcher: ChatMatcher;
  private stopped = true;
  private connecting = false;
  private wasLinked = false;
  private retryMs = FIRST_RETRY_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private codeRefreshes = 0;
  /** Full keys of recent incoming messages, needed to send read receipts. */
  private readonly keys = new Map<string, KeyLike>();
  private readonly log: (line: string) => void;

  constructor(private readonly opts: Options) {
    this.matcher = { digits: null, lid: opts.lid ?? null };
    this.log = opts.log ?? (() => {});
  }

  /** Connects, or tries again after it gave up waiting for a code to be scanned. */
  async start(): Promise<void> {
    this.stopped = false;
    this.codeRefreshes = 0;
    if (this.sock || this.connecting) return;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRetry();
    const sock = this.sock;
    this.sock = null;
    if (sock) await sock.end(undefined).catch(() => {});
  }

  status(): LinkStatus {
    return this.current;
  }

  subscribe(handler: (e: TransportEvent) => void): void {
    this.handlers.push(handler);
  }

  setChat(phoneDigits: string | null): void {
    const digits = phoneDigits && phoneDigits !== '' ? phoneDigits : null;
    if (digits !== this.matcher.digits) this.matcher = { digits, lid: null };
    void this.resolveLid();
  }

  async sendText(text: string): Promise<{ waId: string; ts: number }> {
    const sock = this.sock;
    const digits = this.matcher.digits;
    if (!sock || this.current.state !== 'linked') throw new Error('WhatsApp is not linked right now.');
    if (!digits) throw new Error('No chat has been chosen.');
    const sent = await sock.sendMessage(phoneJid(digits), { text });
    const waId = sent?.key?.id;
    if (!waId) throw new Error('WhatsApp did not confirm the message.');
    return { waId, ts: Date.now() };
  }

  async markRead(waIds: string[]): Promise<void> {
    const sock = this.sock;
    if (!sock || this.current.state !== 'linked' || waIds.length === 0) return;
    const fallback = this.matcher.lid ?? (this.matcher.digits ? phoneJid(this.matcher.digits) : null);
    const keys = waIds
      .map((id) => this.keys.get(id) ?? (fallback ? { remoteJid: fallback, id, fromMe: false } : null))
      .filter((k): k is KeyLike => k !== null);
    if (keys.length > 0) await sock.readMessages(keys as Parameters<WASocket['readMessages']>[0]);
  }

  async requestPairingCode(phoneDigits: string): Promise<string> {
    const sock = this.sock;
    if (!sock || this.current.state !== 'linking') throw new Error('Open the link screen first, then ask for a number code.');
    const code = await sock.requestPairingCode(phoneDigits);
    this.setStatus('linking', { qr: this.current.qr, pairingCode: code });
    return code;
  }

  async logout(): Promise<void> {
    this.stopped = true;
    this.clearRetry();
    const sock = this.sock;
    this.sock = null;
    if (sock) await sock.logout().catch(() => {});
    await this.forgetSession();
    this.setStatus('unlinked');
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    try {
      await fs.mkdir(this.opts.authDir, { recursive: true, mode: 0o700 });
      const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir);
      this.wasLinked = Boolean(state.creds.me);
      if (!this.wasLinked) this.setStatus('linking');

      const sock = makeWASocket({
        auth: state,
        logger: quietLogger(this.log),
        // Leave the phone as the device that shows as online, so it keeps getting notifications.
        markOnlineOnConnect: false,
        syncFullHistory: false,
        // Groups, broadcasts and channels are never read. One-to-one chats are filtered per message below.
        shouldIgnoreJid: (jid) => !isUserJid(jid),
      });
      this.sock = sock;

      sock.ev.on('creds.update', () => void saveCreds());
      sock.ev.on('connection.update', (update) => void this.onConnection(sock, update));
      sock.ev.on('messages.upsert', (event) => this.onMessages(event.messages));
      sock.ev.on('lid-mapping.update', (mapping) => this.onMapping(mapping));
    } catch (e) {
      this.log(`whatsapp: could not start (${e instanceof Error ? e.message : String(e)})`);
      this.scheduleRetry();
    } finally {
      this.connecting = false;
    }
  }

  private async onConnection(
    sock: WASocket,
    update: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } },
  ): Promise<void> {
    if (sock !== this.sock) return;

    if (update.qr) {
      const image = await QRCode.toDataURL(update.qr, { margin: 1, width: 320 });
      if (sock !== this.sock) return;
      this.setStatus('linking', { qr: image, pairingCode: this.current.pairingCode });
    }

    if (update.connection === 'open') {
      this.wasLinked = true;
      this.retryMs = FIRST_RETRY_MS;
      this.codeRefreshes = 0;
      this.setStatus('linked');
      void this.resolveLid();
      return;
    }

    if (update.connection !== 'close') return;
    this.sock = null;
    if (this.stopped) return;

    const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;

    if (code === DisconnectReason.loggedOut) {
      // The phone removed this device, or WhatsApp ended the session. The saved session is useless now.
      await this.forgetSession();
      this.wasLinked = false;
      this.setStatus('unlinked');
      return;
    }

    if (code === DisconnectReason.restartRequired) {
      // A normal step straight after a code is scanned.
      await this.connect();
      return;
    }

    if (this.wasLinked) {
      this.setStatus('down');
      this.scheduleRetry();
      return;
    }

    // Not linked yet: the code expired unscanned. Fetch a new one a few times, then wait to be asked.
    this.codeRefreshes += 1;
    if (this.codeRefreshes > MAX_CODE_REFRESHES) {
      this.stopped = true;
      this.setStatus('unlinked');
      return;
    }
    await this.connect();
  }

  private onMessages(messages: { key: KeyLike; message?: unknown; messageTimestamp?: unknown }[]): void {
    for (const m of messages) {
      // Second gate: anything that is not the allowed chat stops here and is never stored or passed on.
      if (!matchesChat(m.key, this.matcher)) continue;
      const lid = learnLid(m.key, this.matcher);
      if (lid) this.rememberLid(lid);
      const inbound = toInbound(m);
      if (!inbound) continue;
      if (!inbound.fromMe) this.rememberKey(inbound.waId, m.key);
      this.emit({ type: 'message', message: inbound });
    }
  }

  private onMapping(mapping: { pn: string; lid: string }): void {
    const digits = this.matcher.digits;
    if (!digits) return;
    if (matchesChat({ remoteJid: mapping.pn }, { digits, lid: null }) && mapping.lid.endsWith('@lid')) {
      this.rememberLid(mapping.lid);
    }
  }

  private async resolveLid(): Promise<void> {
    const sock = this.sock;
    const digits = this.matcher.digits;
    if (!sock || !digits || this.matcher.lid || this.current.state !== 'linked') return;
    try {
      const lid = await sock.signalRepository.lidMapping.getLIDForPN(phoneJid(digits));
      if (lid && digits === this.matcher.digits) this.rememberLid(lid);
    } catch {
      // Not known yet. It is learned from the first message instead.
    }
  }

  private rememberLid(raw: string): void {
    const at = raw.indexOf('@');
    if (at === -1) return;
    const lid = `${raw.slice(0, at).split(':')[0]}${raw.slice(at)}`;
    if (!lid.endsWith('@lid') || lid === this.matcher.lid) return;
    this.matcher = { ...this.matcher, lid };
    this.opts.onLid?.(lid);
  }

  private rememberKey(waId: string, key: KeyLike): void {
    this.keys.set(waId, key);
    if (this.keys.size > REMEMBERED_KEYS) {
      const oldest = this.keys.keys().next().value;
      if (oldest !== undefined) this.keys.delete(oldest);
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, wait);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async forgetSession(): Promise<void> {
    await fs.rm(this.opts.authDir, { recursive: true, force: true }).catch(() => {});
  }

  private setStatus(state: LinkState, extra: { qr?: string | null; pairingCode?: string | null } = {}): void {
    const since = state === this.current.state ? this.current.since : Date.now();
    this.current = { state, qr: extra.qr ?? null, pairingCode: extra.pairingCode ?? null, since };
    this.emit({ type: 'status', status: this.current });
  }

  private emit(e: TransportEvent): void {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        this.log(`whatsapp: a listener failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }
}
