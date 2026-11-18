import { describe, expect, it } from 'vitest';

import { trialMachineEnabled } from '@/lib/trial/flag';

// Le template Nomad rend TRIAL_MACHINE_ENABLED avec défaut 1 : seule la valeur 0 coupe l'essai.
describe('drapeau TRIAL_MACHINE_ENABLED', () => {
  it('0 coupe', () => {
    expect(trialMachineEnabled({ TRIAL_MACHINE_ENABLED: '0' } as NodeJS.ProcessEnv)).toBe(false);
  });
  it('1 allume', () => {
    expect(trialMachineEnabled({ TRIAL_MACHINE_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });
  it('absent allume (défaut du template)', () => {
    expect(trialMachineEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });
});
