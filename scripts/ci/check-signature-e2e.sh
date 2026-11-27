#!/usr/bin/env bash
# Aucun spec ne signe à la main vers une app (parente, 27/11). Tout `createHmac(` d'un fichier de e2e/ porte, sur sa ligne ou dans les 3 lignes
# au-dessus, la marque `vers-le-hub` : une signature que le HUB vérifie (délégation, invitation, webhooks). Vers une app, on signe par
# e2e/systeme-sso/lib/signature-app.ts (le signataire du Hub, en v2). Pourquoi : douze HMAC v1 faits à la main rendaient NON ABOUTI tout cas vers
# Academy (v1 refusée) et empêchaient Mail, le CRM et Prospection de fermer la v1 (69 appels v1 en 24 h, tous de la batterie).
# Sortie : 0 rien à redire · 1 une signature à la main sans marque · 2 mesure non aboutie.
set -u
cd "$(dirname "$0")/../.." || exit 2
[ -d e2e ] || { echo "check-signature-e2e — NON ABOUTI : pas de dossier e2e/"; exit 2; }
python3 -I - <<'PY'
import pathlib, sys
fautes, vus = [], 0
for p in sorted(pathlib.Path('e2e').rglob('*.ts')):
    if 'node_modules' in p.parts or p.as_posix() == 'e2e/systeme-sso/lib/signature-app.ts':
        continue
    lignes = p.read_text(encoding='utf-8', errors='replace').split('\n')
    for i, l in enumerate(lignes):
        if 'createHmac(' not in l or l.lstrip().startswith('import'):
            continue
        vus += 1
        if not any('vers-le-hub' in x for x in lignes[max(0, i - 3):i + 1]):
            fautes.append(f'{p}:{i + 1}')
if fautes:
    print('✗ signature faite à la main dans e2e/, sans la marque « vers-le-hub » :')
    for f in fautes:
        print('   ', f)
    print('  Vers une app : signatureVersApp() de e2e/systeme-sso/lib/signature-app.ts (v2, le signataire du Hub).')
    print('  Vers le Hub (il vérifie lui-même) : commentaire « vers-le-hub : <ce que le Hub vérifie> » juste au-dessus.')
    sys.exit(1)
print(f'✓ signatures des e2e : {vus} HMAC, tous vers le Hub et marqués ; vers les apps, signature-app.ts')
PY
