import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let out = '';
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  return Array.from(bytes, (b) => b % 32);
}

/** Increment the random component in place so IDs minted in the same ms still sort. */
function bumpRandom(values: number[]): number[] {
  const out = values.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const v = out[i] ?? 0;
    if (v < 31) {
      out[i] = v + 1;
      return out;
    }
    out[i] = 0;
  }
  // Overflowed a full 16-char random space inside one millisecond: start over.
  return freshRandom();
}

/**
 * Monotonic ULID. Lexicographic sort order matches creation order, which lets
 * request logs be range-scanned by ID without a secondary timestamp index.
 */
export function ulid(now = Date.now()): string {
  if (now === lastTime) {
    lastRandom = bumpRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = freshRandom();
  }
  return encodeTime(now) + lastRandom.map((v) => CROCKFORD[v]).join('');
}

/** Extract the millisecond timestamp a ULID was minted at. */
export function ulidTime(id: string): number {
  const time = id.slice(0, TIME_LEN);
  let ms = 0;
  for (const ch of time) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx === -1) throw new Error(`invalid ULID character: ${ch}`);
    ms = ms * 32 + idx;
  }
  return ms;
}

export type IdPrefix =
  | 'req'
  | 'att'
  | 'evt'
  | 'org'
  | 'proj'
  | 'key'
  | 'prov'
  | 'mdl'
  | 'pol'
  | 'bud'
  | 'usg'
  | 'whk'
  | 'alr'
  | 'cache'
  | 'aud'
  | 'hlth'
  | 'ver';

export function newId(prefix: IdPrefix, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}

export const newRequestId = (now?: number) => newId('req', now);
export const newAttemptId = (now?: number) => newId('att', now);
export const newEventId = (now?: number) => newId('evt', now);
