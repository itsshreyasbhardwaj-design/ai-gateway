import { describe, expect, it } from 'vitest';
import { ulid, ulidTime } from '@ai-gateway/core';

describe('workspace wiring', () => {
  it('resolves workspace aliases from source', () => {
    const id = ulid(1700000000000);
    expect(id).toHaveLength(26);
    expect(ulidTime(id)).toBe(1700000000000);
  });
});
