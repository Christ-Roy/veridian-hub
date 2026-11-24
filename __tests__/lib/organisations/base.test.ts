// @vitest-environment node
import { expect, it } from 'vitest';

import { hubPublicUrl } from '@/lib/organisations/base';

it('hubPublicUrl : AUTH_URL de l\'exécution, sans barre finale ; la prod à défaut', () => {
  expect(hubPublicUrl({ NODE_ENV: 'test', AUTH_URL: 'https://hub.staging.veridian.site/' })).toBe('https://hub.staging.veridian.site');
  expect(hubPublicUrl({ NODE_ENV: 'test' })).toBe('https://app.veridian.site');
});
