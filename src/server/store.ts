import { DatabaseSync } from 'node:sqlite';
import type { ContextLine, Message, Note } from './types.js';

type Row = {
  id: string;
  wa_id: string | null;
  direction: string;
  source: string;
  kind: string;
  original: string;
  translation: string | null;
  back_translation: string | null;
  notes: string;
  ambiguity: string | null;
  status: string;
  ts: number;
  read: number;
};

const COLUMNS: Record<keyof Message, string> = {
  id: 'id',
  waId: 'wa_id',
  direction: 'direction',
  source: 'source',
  kind: 'kind',
  original: 'original',
  translation: 'translation',
  backTranslation: 'back_translation',
  notes: 'notes',
  ambiguity: 'ambiguity',
  status: 'status',
  ts: 'ts',
  read: 'read',
};

function parseNotes(raw: string): Note[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as Note[]) : [];
  } catch {
    return [];
  }
}

function fromRow(r: Row): Message {
  return {
    id: r.id,
    waId: r.wa_id,
    direction: r.direction as Message['direction'],
    source: r.source as Message['source'],
    kind: r.kind as Message['kind'],
    original: r.original,
    translation: r.translation,
    backTranslation: r.back_translation,
    notes: parseNotes(r.notes),
    ambiguity: r.ambiguity,
    status: r.status as Message['status'],
    ts: Number(r.ts),
    read: r.read === 1,
  };
}

function toSql(key: keyof Message, value: Message[keyof Message]): string | number | null {
  if (key === 'notes') return JSON.stringify(value ?? []);
  if (key === 'read') return value ? 1 : 0;
  return (value ?? null) as string | number | null;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        wa_id TEXT,
        direction TEXT NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        original TEXT NOT NULL,
        translation TEXT,
        back_translation TEXT,
        notes TEXT NOT NULL DEFAULT '[]',
        ambiguity TEXT,
        status TEXT NOT NULL,
        ts INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS messages_wa_id ON messages (wa_id) WHERE wa_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    `);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return;
    }
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** Returns false, writing nothing, when a row with the same waId already exists. */
  insertMessage(m: Message): boolean {
    const keys = Object.keys(COLUMNS) as (keyof Message)[];
    const sql = `INSERT INTO messages (${keys.map((k) => COLUMNS[k]).join(', ')})
      VALUES (${keys.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`;
    const result = this.db.prepare(sql).run(...keys.map((k) => toSql(k, m[k])));
    return Number(result.changes) === 1;
  }

  updateMessage(id: string, patch: Partial<Message>): Message {
    const keys = (Object.keys(patch) as (keyof Message)[]).filter((k) => k !== 'id' && k in COLUMNS);
    if (keys.length > 0) {
      const sql = `UPDATE messages SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`;
      this.db.prepare(sql).run(...keys.map((k) => toSql(k, patch[k] as Message[keyof Message])), id);
    }
    const out = this.getMessage(id);
    if (!out) throw new Error(`No message with id ${id}`);
    return out;
  }

  getMessage(id: string): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** The newest `limit` messages (older than `before` when given), returned oldest first. */
  listMessages(opts: { before?: number; limit: number }): Message[] {
    const rows =
      opts.before === undefined
        ? (this.db.prepare('SELECT * FROM messages ORDER BY ts DESC, rowid DESC LIMIT ?').all(opts.limit) as Row[])
        : (this.db
            .prepare('SELECT * FROM messages WHERE ts < ? ORDER BY ts DESC, rowid DESC LIMIT ?')
            .all(opts.before, opts.limit) as Row[]);
    return rows.reverse().map(fromRow);
  }

  /** The most recent text messages (older than `before` when given) in their authors' own words, oldest first. */
  recentContext(limit: number, before?: number): ContextLine[] {
    const rows = this.db
      .prepare("SELECT direction, original FROM messages WHERE kind = 'text' AND ts < ? ORDER BY ts DESC, rowid DESC LIMIT ?")
      .all(before ?? Number.MAX_SAFE_INTEGER, limit) as { direction: string; original: string }[];
    return rows.reverse().map((r) => ({ speaker: r.direction === 'in' ? 'Juan' : 'Casey', text: r.original }));
  }

  /** Marks the given messages read and returns the WhatsApp ids of those that were unread. */
  markRead(ids: string[]): string[] {
    const waIds: string[] = [];
    const select = this.db.prepare('SELECT wa_id, read FROM messages WHERE id = ?');
    const update = this.db.prepare('UPDATE messages SET read = 1 WHERE id = ?');
    for (const id of ids) {
      const row = select.get(id) as { wa_id: string | null; read: number } | undefined;
      if (!row || row.read === 1) continue;
      update.run(id);
      if (row.wa_id) waIds.push(row.wa_id);
    }
    return waIds;
  }

  createSession(tokenHash: string, expires: number): void {
    this.db
      .prepare('INSERT INTO sessions (token_hash, expires) VALUES (?, ?) ON CONFLICT(token_hash) DO UPDATE SET expires = excluded.expires')
      .run(tokenHash, expires);
  }

  hasSession(tokenHash: string, now: number): boolean {
    const row = this.db.prepare('SELECT expires FROM sessions WHERE token_hash = ?').get(tokenHash) as
      | { expires: number }
      | undefined;
    return row !== undefined && Number(row.expires) > now;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  close(): void {
    this.db.close();
  }
}
