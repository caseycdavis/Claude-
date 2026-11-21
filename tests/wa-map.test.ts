import { describe, expect, test } from 'vitest';
import {
  digitsOnly,
  isUserJid,
  learnLid,
  matchesChat,
  phoneJid,
  toInbound,
  type ChatMatcher,
} from '../src/server/transport/wa-map.js';

const JUAN = '573001234567';
const JUAN_PN = `${JUAN}@s.whatsapp.net`;
const JUAN_LID = '99887766554433@lid';
const matcher: ChatMatcher = { digits: JUAN, lid: null };

describe('numbers and jids', () => {
  test('digitsOnly strips everything but digits', () => {
    expect(digitsOnly('+57 (300) 123-4567')).toBe('573001234567');
    expect(digitsOnly('')).toBe('');
  });

  test('phoneJid builds the phone-number form', () => {
    expect(phoneJid(JUAN)).toBe(JUAN_PN);
  });

  test('isUserJid is true only for one-to-one addresses', () => {
    expect(isUserJid(JUAN_PN)).toBe(true);
    expect(isUserJid(JUAN_LID)).toBe(true);
    expect(isUserJid('120363012345678901@g.us')).toBe(false);
    expect(isUserJid('status@broadcast')).toBe(false);
    expect(isUserJid('12345@newsletter')).toBe(false);
    expect(isUserJid(undefined)).toBe(false);
  });
});

describe('matchesChat', () => {
  test('is true for the allowlisted phone-number jid', () => {
    expect(matchesChat({ remoteJid: JUAN_PN }, matcher)).toBe(true);
  });

  test('ignores a device suffix on the jid', () => {
    expect(matchesChat({ remoteJid: `${JUAN}:14@s.whatsapp.net` }, matcher)).toBe(true);
  });

  // Review Focus 1
  test('is false for another number, a group, a status broadcast and a null matcher', () => {
    expect(matchesChat({ remoteJid: '573009999999@s.whatsapp.net' }, matcher)).toBe(false);
    expect(matchesChat({ remoteJid: '120363012345678901@g.us' }, matcher)).toBe(false);
    expect(matchesChat({ remoteJid: 'status@broadcast' }, matcher)).toBe(false);
    expect(matchesChat({ remoteJid: JUAN_PN }, { digits: null, lid: null })).toBe(false);
    expect(matchesChat({ remoteJid: null }, matcher)).toBe(false);
    expect(matchesChat({}, matcher)).toBe(false);
  });

  test('is false for a group even when Juan is the participant', () => {
    const key = { remoteJid: '120363012345678901@g.us', participant: JUAN_PN, participantAlt: JUAN_LID };
    expect(matchesChat(key, matcher)).toBe(false);
  });

  test('a number that merely contains the allowlisted digits does not match', () => {
    expect(matchesChat({ remoteJid: `1${JUAN}@s.whatsapp.net` }, matcher)).toBe(false);
    expect(matchesChat({ remoteJid: `${JUAN}9@s.whatsapp.net` }, matcher)).toBe(false);
  });

  // Review Focus 2
  test('is true when the chat is addressed by LID and the phone form rides alongside', () => {
    expect(matchesChat({ remoteJid: JUAN_LID, remoteJidAlt: JUAN_PN }, matcher)).toBe(true);
  });

  // Review Focus 2
  test('is true for the learned LID with no phone form at all', () => {
    expect(matchesChat({ remoteJid: JUAN_LID }, { digits: JUAN, lid: JUAN_LID })).toBe(true);
    expect(matchesChat({ remoteJid: JUAN_LID }, matcher)).toBe(false);
  });

  test('an unrelated LID does not match', () => {
    expect(matchesChat({ remoteJid: '11111111111111@lid' }, { digits: JUAN, lid: JUAN_LID })).toBe(false);
  });
});

describe('learnLid', () => {
  test('returns the LID when the phone form matched through the alternate field', () => {
    expect(learnLid({ remoteJid: JUAN_LID, remoteJidAlt: JUAN_PN }, matcher)).toBe(JUAN_LID);
    expect(learnLid({ remoteJid: JUAN_PN, remoteJidAlt: JUAN_LID }, matcher)).toBe(JUAN_LID);
  });

  test('returns null when there is nothing new to learn', () => {
    expect(learnLid({ remoteJid: JUAN_PN }, matcher)).toBeNull();
    expect(learnLid({ remoteJid: '11111111111111@lid', remoteJidAlt: '573009999999@s.whatsapp.net' }, matcher)).toBeNull();
    expect(learnLid({ remoteJid: JUAN_LID, remoteJidAlt: JUAN_PN }, { digits: JUAN, lid: JUAN_LID })).toBeNull();
  });
});

describe('toInbound', () => {
  const key = { remoteJid: JUAN_PN, fromMe: false, id: 'ABC123' };

  test('reads plain conversation text', () => {
    expect(toInbound({ key, message: { conversation: 'hola parce' }, messageTimestamp: 1700000000 })).toEqual({
      waId: 'ABC123',
      fromMe: false,
      ts: 1700000000000,
      kind: 'text',
      text: 'hola parce',
    });
  });

  test('reads extended text', () => {
    const m = toInbound({ key, message: { extendedTextMessage: { text: 'con enlace' } }, messageTimestamp: 1 });
    expect(m).toMatchObject({ kind: 'text', text: 'con enlace' });
  });

  test('marks a message sent from the owner’s own phone', () => {
    const m = toInbound({ key: { ...key, fromMe: true }, message: { conversation: 'hi' }, messageTimestamp: 1 });
    expect(m!.fromMe).toBe(true);
  });

  test('unwraps a disappearing-message wrapper', () => {
    const m = toInbound({ key, message: { ephemeralMessage: { message: { conversation: 'temporal' } } }, messageTimestamp: 1 });
    expect(m).toMatchObject({ kind: 'text', text: 'temporal' });
  });

  test('labels a voice note', () => {
    const m = toInbound({ key, message: { audioMessage: { ptt: true, seconds: 14 } }, messageTimestamp: 1 });
    expect(m).toMatchObject({ kind: 'other', text: 'Voice note' });
  });

  test('labels a photo and keeps its caption', () => {
    expect(toInbound({ key, message: { imageMessage: {} }, messageTimestamp: 1 })).toMatchObject({ kind: 'other', text: 'Photo' });
    expect(toInbound({ key, message: { imageMessage: { caption: 'la vista' } }, messageTimestamp: 1 })).toMatchObject({
      kind: 'other',
      text: 'Photo: la vista',
    });
  });

  test('labels other kinds it cannot show', () => {
    expect(toInbound({ key, message: { stickerMessage: {} }, messageTimestamp: 1 })!.text).toBe('Sticker');
    expect(toInbound({ key, message: { videoMessage: {} }, messageTimestamp: 1 })!.text).toBe('Video');
    expect(toInbound({ key, message: { documentMessage: {} }, messageTimestamp: 1 })!.text).toBe('Document');
    expect(toInbound({ key, message: { locationMessage: {} }, messageTimestamp: 1 })!.text).toBe('Location');
    expect(toInbound({ key, message: { somethingNewMessage: {} }, messageTimestamp: 1 })).toMatchObject({
      kind: 'other',
      text: 'A message this app cannot show',
    });
  });

  test('returns null for a reaction, a protocol message and an empty message', () => {
    expect(toInbound({ key, message: { reactionMessage: { text: 'x' } }, messageTimestamp: 1 })).toBeNull();
    expect(toInbound({ key, message: { protocolMessage: { type: 0 } }, messageTimestamp: 1 })).toBeNull();
    expect(toInbound({ key, message: {}, messageTimestamp: 1 })).toBeNull();
    expect(toInbound({ key, messageTimestamp: 1 })).toBeNull();
    expect(toInbound({ key, message: { senderKeyDistributionMessage: {}, messageContextInfo: {} }, messageTimestamp: 1 })).toBeNull();
  });

  test('returns null without a message id', () => {
    expect(toInbound({ key: { remoteJid: JUAN_PN }, message: { conversation: 'x' }, messageTimestamp: 1 })).toBeNull();
  });

  test('converts a Long-like timestamp to milliseconds', () => {
    const long = { low: 1700000000, high: 0, unsigned: true, toNumber: () => 1700000000 };
    expect(toInbound({ key, message: { conversation: 'x' }, messageTimestamp: long })!.ts).toBe(1700000000000);
  });

  test('falls back to the supplied clock when the timestamp is missing', () => {
    expect(toInbound({ key, message: { conversation: 'x' } }, () => 4242)!.ts).toBe(4242);
  });
});
