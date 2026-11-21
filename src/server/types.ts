export type Direction = 'in' | 'out';
export type Tone = 'base' | 'warmer' | 'firmer' | 'playful' | 'shorter';
export const TONES: readonly Tone[] = ['base', 'warmer', 'firmer', 'playful', 'shorter'];
export type MessageStatus = 'translating' | 'done' | 'failed' | 'skipped' | 'sent';
export type Note = { term: string; meaning: string };

export type Message = {
  id: string;
  /** WhatsApp's own id for the message; null until known. */
  waId: string | null;
  direction: Direction;
  /** juan: received. app: sent from this app. phone: sent by Casey from WhatsApp itself. */
  source: 'juan' | 'app' | 'phone';
  kind: 'text' | 'other';
  /** What the author wrote, in the author's language. */
  original: string;
  translation: string | null;
  /** Outgoing only: an independent literal English reading of the Spanish that was sent. */
  backTranslation: string | null;
  notes: Note[];
  ambiguity: string | null;
  status: MessageStatus;
  ts: number;
  read: boolean;
};

export type ContextLine = { speaker: 'Casey' | 'Juan'; text: string };
export type Profile = { instructions: string; aboutUs: string; glossary: Note[] };
export type IncomingResult = { english: string; notes: Note[]; ambiguity: string | null };
export type OutgoingResult = { spanish: string; notes: Note[]; ambiguity: string | null };

export interface Translator {
  incoming(i: { text: string; context: ContextLine[]; profile: Profile }): Promise<IncomingResult>;
  outgoing(i: { text: string; tone: Tone; context: ContextLine[]; profile: Profile }): Promise<OutgoingResult>;
  /** Sees only the Spanish, so the reading is an independent check. */
  backTranslate(spanish: string): Promise<string>;
}

export type LinkState = 'unlinked' | 'linking' | 'linked' | 'down';
export type LinkStatus = { state: LinkState; qr: string | null; pairingCode: string | null; since: number };
export type InboundMessage = { waId: string; fromMe: boolean; ts: number; kind: 'text' | 'other'; text: string };
export type TransportEvent =
  | { type: 'message'; message: InboundMessage }
  | { type: 'status'; status: LinkStatus };

export interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): LinkStatus;
  subscribe(handler: (e: TransportEvent) => void): void;
  /** The one chat this program may read and write. Null means none. */
  setChat(phoneDigits: string | null): void;
  sendText(text: string): Promise<{ waId: string; ts: number }>;
  markRead(waIds: string[]): Promise<void>;
  requestPairingCode(phoneDigits: string): Promise<string>;
  logout(): Promise<void>;
}
