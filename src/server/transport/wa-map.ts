import type { InboundMessage } from '../types.js';

/** The pieces of a WhatsApp message key this program reads. */
export type KeyLike = { remoteJid?: string | null; remoteJidAlt?: string | null; fromMe?: boolean | null; id?: string | null };

/** The one allowed chat: Juan's phone number, plus WhatsApp's opaque id for him once learned. */
export type ChatMatcher = { digits: string | null; lid: string | null };

export function digitsOnly(input: string): string {
  return input.replace(/\D/g, '');
}

export function phoneJid(digits: string): string {
  return `${digits}@s.whatsapp.net`;
}

/** Drops a device suffix: 5730...:14@s.whatsapp.net -> 5730...@s.whatsapp.net */
function normalize(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const at = jid.indexOf('@');
  if (at === -1) return null;
  const user = jid.slice(0, at).split(':')[0];
  return `${user}${jid.slice(at)}`;
}

function isLid(jid: string | null): jid is string {
  return jid !== null && jid.endsWith('@lid');
}

/** True for a one-to-one address, false for groups, broadcasts, channels and anything else. */
export function isUserJid(jid: string | null | undefined): boolean {
  const n = normalize(jid);
  return n !== null && (n.endsWith('@s.whatsapp.net') || n.endsWith('@lid'));
}

/**
 * True only when the message belongs to the allowed one-to-one chat.
 * WhatsApp may address a chat by phone number or by an opaque LID, with the other form alongside.
 */
export function matchesChat(key: KeyLike, m: ChatMatcher): boolean {
  if (m.digits === null && m.lid === null) return false;
  const primary = normalize(key.remoteJid);
  if (!isUserJid(primary)) return false;
  const candidates = [primary, normalize(key.remoteJidAlt)];
  const pn = m.digits === null ? null : phoneJid(m.digits);
  return candidates.some((c) => c !== null && (c === pn || (m.lid !== null && c === m.lid)));
}

/** When a message matched by phone number also carries a LID not yet known, returns that LID. */
export function learnLid(key: KeyLike, m: ChatMatcher): string | null {
  if (m.digits === null) return null;
  const pn = phoneJid(m.digits);
  const a = normalize(key.remoteJid);
  const b = normalize(key.remoteJidAlt);
  let lid: string | null = null;
  if (a === pn && isLid(b)) lid = b;
  if (b === pn && isLid(a)) lid = a;
  return lid !== null && lid !== m.lid ? lid : null;
}

const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage'];

function unwrap(message: any): any {
  let current = message;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const wrapper = WRAPPERS.find((w) => current[w]?.message);
    if (!wrapper) break;
    current = current[wrapper].message;
  }
  return current;
}

/** Entries that carry no content of their own. */
const SILENT = new Set(['senderKeyDistributionMessage', 'messageContextInfo', 'protocolMessage', 'reactionMessage']);

const LABELS: Record<string, string> = {
  stickerMessage: 'Sticker',
  documentMessage: 'Document',
  locationMessage: 'Location',
  liveLocationMessage: 'Location',
  contactMessage: 'Contact card',
  contactsArrayMessage: 'Contact card',
  pollCreationMessage: 'Poll',
  pollCreationMessageV2: 'Poll',
  pollCreationMessageV3: 'Poll',
};

function withCaption(label: string, caption: unknown): string {
  return typeof caption === 'string' && caption.trim() !== '' ? `${label}: ${caption.trim()}` : label;
}

function toMillis(ts: unknown, now: () => number): number {
  if (ts === null || ts === undefined) return now();
  const n = typeof (ts as any).toNumber === 'function' ? (ts as any).toNumber() : Number(ts);
  return Number.isFinite(n) && n > 0 ? n * 1000 : now();
}

/** Turns a WhatsApp message into what this program stores, or null when there is nothing to show. */
export function toInbound(
  msg: { key: KeyLike; message?: any; messageTimestamp?: unknown },
  now: () => number = Date.now,
): InboundMessage | null {
  const waId = msg.key.id;
  if (!waId) return null;
  const content = unwrap(msg.message);
  if (!content) return null;
  const kinds = Object.keys(content).filter((k) => content[k] !== null && content[k] !== undefined && !SILENT.has(k));
  if (kinds.length === 0) return null;

  const base = { waId, fromMe: Boolean(msg.key.fromMe), ts: toMillis(msg.messageTimestamp, now) };
  const text = typeof content.conversation === 'string' ? content.conversation : content.extendedTextMessage?.text;
  if (typeof text === 'string' && text !== '') return { ...base, kind: 'text', text };

  if (content.audioMessage) return { ...base, kind: 'other', text: content.audioMessage.ptt ? 'Voice note' : 'Audio' };
  if (content.imageMessage) return { ...base, kind: 'other', text: withCaption('Photo', content.imageMessage.caption) };
  if (content.videoMessage) return { ...base, kind: 'other', text: withCaption('Video', content.videoMessage.caption) };
  const known = kinds.find((k) => LABELS[k] !== undefined);
  return { ...base, kind: 'other', text: known ? LABELS[known]! : 'A message this app cannot show' };
}
