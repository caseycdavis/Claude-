import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Returns "salt:hash" in hex. The passphrase itself is never stored. */
export function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(passphrase, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassphrase(passphrase: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== 64) return false;
  const actual = scryptSync(passphrase, Buffer.from(saltHex, 'hex'), 64);
  return timingSafeEqual(actual, expected);
}

export function newSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/** Sessions are stored by hash, so the database alone cannot be used to sign in. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Counts failed sign-ins per address inside a sliding window. */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private recent(ip: string, now: number): number[] {
    const kept = (this.failures.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (kept.length === 0) this.failures.delete(ip);
    else this.failures.set(ip, kept);
    return kept;
  }

  allow(ip: string, now: number): boolean {
    return this.recent(ip, now).length < this.max;
  }

  fail(ip: string, now: number): void {
    this.failures.set(ip, [...this.recent(ip, now), now]);
  }

  reset(ip: string): void {
    this.failures.delete(ip);
  }
}
