/**
 * zod sans compilation de schémas : la CSP du Hub interdit eval (VER-265), et zod essaie `Function("")` à la CONSTRUCTION de chaque schéma
 * objet quand il peut compiler (zod/v4/core/schemas.js lit `globalConfig.jitless` à ce moment-là). Ce module doit donc être importé AVANT
 * tout module qui construit des schémas (le SDK `ai`) : un réglage posé après les imports arrive trop tard (mesuré le 26/11, cas 52).
 */
import { config } from 'zod';

config({ jitless: true });
