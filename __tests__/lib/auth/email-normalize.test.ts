import { describe, it, expect } from 'vitest';
import { normaliserEmail } from '@/lib/auth/email-normalize';

describe('normaliserEmail (D6)', () => {
  it.each([
    ['Robert@X.com', 'robert@x.com'],
    ['  a@x.fr  ', 'a@x.fr'],
    ['A@X.fr', 'a@x.fr'],
  ])('%j → %s', (brut, attendu) => {
    expect(normaliserEmail(brut)).toBe(attendu);
  });
});
