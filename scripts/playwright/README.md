# Notifuse Wizard Automation

Script Playwright pour automatiser le wizard de setup initial de Notifuse.

## Installation

```bash
npm install
npx playwright install chromium
```

## Usage

### Lancer le test en mode headless (sans UI)
```bash
npm run test:notifuse
```

### Lancer avec UI Playwright (pour voir ce qui se passe)
```bash
npm run test:notifuse:ui
```

### Lancer en mode headed (avec navigateur visible)
```bash
npm run test:notifuse:headed
```

### Lancer en mode debug (avec pas-à-pas)
```bash
npm run test:notifuse:debug
```

## Variables d'environnement

Vous pouvez override l'URL de Notifuse:

```bash
# URL personnalisée
NOTIFUSE_BASE_URL="https://notifuse.mysite.com" npm run test:notifuse

# URL de setup spécifique
NOTIFUSE_SETUP_URL="https://notifuse.mysite.com/console/setup" npm run test:notifuse
```

## Intégration dans le provisioning

Pour intégrer ce script dans le workflow de provisioning, vous pouvez l'appeler depuis Node.js:

```javascript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function completeNotifuseWizard(setupUrl: string) {
  console.log('🔧 Completing Notifuse wizard...');

  const { stdout, stderr } = await execAsync(
    `npx playwright test notifuse-wizard.spec.ts`,
    {
      cwd: '/path/to/scripts/playwright',
      env: {
        ...process.env,
        NOTIFUSE_SETUP_URL: setupUrl
      }
    }
  );

  if (stderr) {
    console.error('Playwright stderr:', stderr);
  }

  console.log('✅ Notifuse wizard completed');
}
```
