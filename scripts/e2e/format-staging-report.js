#!/usr/bin/env node
/**
 * format-staging-report.js — transforme un rapport JSON Playwright en récap
 * lisible pour la reco écrite agent (cf. CI-ARCHITECTURE §20.6).
 *
 * Usage : node scripts/e2e/format-staging-report.js e2e-headfull-staging.json
 *
 * Output : stdout, format markdown-friendly pour insertion directe dans la reco.
 */

const fs = require('fs');
const path = require('path');

const file = process.argv[2] || 'e2e-headfull-staging.json';
if (!fs.existsSync(file)) {
  console.error(`✗ Fichier ${file} introuvable`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(file, 'utf8'));

const results = { passed: 0, failed: 0, skipped: 0, total: 0, failures: [] };

function walk(suite, parentTitle = '') {
  const title = parentTitle ? `${parentTitle} > ${suite.title || ''}` : (suite.title || '');
  if (suite.specs) {
    for (const spec of suite.specs) {
      for (const t of spec.tests) {
        for (const r of t.results) {
          results.total++;
          if (r.status === 'passed') results.passed++;
          else if (r.status === 'skipped') results.skipped++;
          else {
            results.failed++;
            results.failures.push({
              title: `${title} > ${spec.title}`,
              error: r.error?.message?.split('\n')[0] || 'no error message',
              duration: r.duration,
            });
          }
        }
      }
    }
  }
  if (suite.suites) {
    for (const s of suite.suites) walk(s, title);
  }
}

for (const root of report.suites || []) walk(root);

const icon = results.failed === 0 ? '✅' : '❌';
console.log('');
console.log(`${icon} E2E headfull staging — ${results.passed}/${results.total - results.skipped} passants (${results.skipped} skipped)`);
console.log('');

if (results.failures.length > 0) {
  console.log('Échecs :');
  for (const f of results.failures) {
    console.log(`  ✗ ${f.title}`);
    console.log(`    ${f.error}`);
  }
  console.log('');
}

// Snippet markdown prêt à coller dans la reco §20.6
console.log('--- snippet reco agent ---');
if (results.failed === 0) {
  console.log(`✅ E2E headfull staging : ${results.passed}/${results.total - results.skipped} parcours OK (durée totale ${Math.round((report.stats?.duration || 0) / 1000)}s)`);
} else {
  console.log(`❌ E2E headfull staging : ${results.failed} parcours en échec sur ${results.total - results.skipped} — promo prod BLOQUÉE`);
  for (const f of results.failures) {
    console.log(`   ✗ ${f.title} : ${f.error}`);
  }
}
