import type { InboundMessage, LinkState, LinkStatus, Transport, TransportEvent } from '../types.js';

/** A stand-in for WhatsApp, used by the demo mode and the tests. Nothing leaves the machine. */
export class FakeTransport implements Transport {
  readonly sent: string[] = [];
  readonly read: string[] = [];
  failSend = false;
  chat: string | null = null;

  private readonly handlers: ((e: TransportEvent) => void)[] = [];
  private current: LinkStatus = { state: 'linked', qr: null, pairingCode: null, since: 0 };
  private counter = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  status(): LinkStatus {
    return this.current;
  }

  subscribe(handler: (e: TransportEvent) => void): void {
    this.handlers.push(handler);
  }

  setChat(phoneDigits: string | null): void {
    this.chat = phoneDigits;
  }

  async sendText(text: string): Promise<{ waId: string; ts: number }> {
    if (this.current.state !== 'linked') throw new Error('The stand-in link is not connected.');
    if (this.failSend) throw new Error('The stand-in link was told to fail this send.');
    this.sent.push(text);
    this.counter += 1;
    return { waId: `fake-out-${this.counter}`, ts: this.now() };
  }

  async markRead(waIds: string[]): Promise<void> {
    this.read.push(...waIds);
  }

  async requestPairingCode(): Promise<string> {
    return 'FAKE-CODE';
  }

  async logout(): Promise<void> {
    this.setState('unlinked');
  }

  setState(state: LinkState): void {
    this.current = { state, qr: null, pairingCode: null, since: this.now() };
    this.emit({ type: 'status', status: this.current });
  }

  emitFromJuan(text: string): InboundMessage {
    this.counter += 1;
    return this.emitRaw({ waId: `fake-in-${this.counter}`, fromMe: false, ts: this.now(), kind: 'text', text });
  }

  emitFromPhone(text: string): InboundMessage {
    this.counter += 1;
    return this.emitRaw({ waId: `fake-phone-${this.counter}`, fromMe: true, ts: this.now(), kind: 'text', text });
  }

  emitRaw(message: InboundMessage): InboundMessage {
    this.emit({ type: 'message', message });
    return message;
  }

  private emit(e: TransportEvent): void {
    for (const h of this.handlers) h(e);
  }
}
