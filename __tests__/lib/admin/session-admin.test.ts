// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ auth: vi.fn(), lire: vi.fn() }));
vi.mock('@/auth', () => ({ auth: m.auth }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: m.lire } } }));
import { sessionAdmin } from '@/lib/admin/session-admin';

const ROBERT = '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
const t = () => Math.floor(Date.now() / 1000);
const s = (o = {}) => m.auth.mockResolvedValue({ user: { id: 'u1', authAt: t(), ...o } });
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('PLATFORM_ADMINS', ROBERT); m.lire.mockResolvedValue({ email: 'r@v', supabaseUserId: ROBERT, emailVerified: new Date() }); });

it('l\'administrateur, connecté depuis moins de 24 h', async () => { s(); expect(await sessionAdmin()).toEqual({ ok: true, userId: 'u1', hubUserId: ROBERT, email: 'r@v' }); });
it.each([
  ['non_connecte', () => m.auth.mockResolvedValue(null)],
  ['emprunt', () => s({ impersonated: true })],
  ['pas_admin', () => s({ federe: true })],
  ['pas_admin', () => { s(); m.lire.mockResolvedValue({ email: 'r@v', supabaseUserId: 'autre', emailVerified: new Date() }); }],
  ['pas_admin', () => { s(); m.lire.mockResolvedValue({ email: 'r@v', supabaseUserId: ROBERT, emailVerified: null }); }],
  ['pas_admin', () => { s(); m.lire.mockRejectedValue(new Error('base')); }],
  ['preuve_ancienne', () => s({ authAt: t() - 86_401 })],
  ['preuve_ancienne', () => s({ authAt: undefined })],
] as const)('refus %s', async (raison, poser) => { poser(); expect(await sessionAdmin()).toEqual({ ok: false, raison }); });
