/**
 * Drapeau du flow d'essai réel. Le template Nomad (deploy/hub.nomad.hcl) rend TRIAL_MACHINE_ENABLED
 * depuis nomad/jobs/hub, défaut 1 si la clé est absente. Seule la valeur « 0 » coupe.
 * Coupure : poser la clé à 0 (bloc complet, par stdin, -check-index), puis rendre le job.
 */
export function trialMachineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRIAL_MACHINE_ENABLED !== '0';
}
