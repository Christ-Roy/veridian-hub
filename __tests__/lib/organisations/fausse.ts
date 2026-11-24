import { base as delegation, table } from '../delegation/fausse';
export const base = () => ({ ...delegation(), organisation: table(['tenantId']), organisationEmission: table(['tenantId', 'app']) });
