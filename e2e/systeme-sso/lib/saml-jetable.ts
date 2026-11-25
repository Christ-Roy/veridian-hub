/**
 * Fournisseur SAML JETABLE (VER-227) : clé et certificat neufs, meurt avec le processus qui l'ouvre. La prochaine identité se choisit (`dire`), et chaque
 * mensonge se commande (`mentir`) pour voir le Hub le refuser. Sert aux tests et à la batterie.
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { SignedXml } from 'xml-crypto';

export type MensongeSaml = null | 'signature' | 'sans_signature' | 'audience' | 'emetteur' | 'expire' | 'autre_demande' | 'sans_demande' | 'sha1' | 'adresse' | 'ephemere' | 'deux_assertions' | 'commentaire' | 'apres_signature';

function certificat(): { cle: string; cert: string } {
  const d = mkdtempSync(join(tmpdir(), 'saml-'));
  try {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const cle = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    writeFileSync(join(d, 'k.pem'), cle, { mode: 0o600 });
    execFileSync('openssl', ['req', '-x509', '-new', '-key', join(d, 'k.pem'), '-days', '2', '-subj', '/CN=epreuve-saml', '-out', join(d, 'c.pem')], { stdio: 'ignore' });
    return { cle, cert: readFileSync(join(d, 'c.pem'), 'utf8') };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export async function ouvrirSaml(hote = '127.0.0.1') {
  const [vrai, autre] = [certificat(), certificat()];
  let qui = 'personne';
  let mensonge: MensongeSaml = null;
  let base = '';
  let demandes = 0;

  /** La réponse à une demande, telle que ce fournisseur la dirait. */
  const repondre = (demande: { id: string; acs: string; sp: string }): string => {
    const t = (ms: number) => new Date(Date.now() + ms).toISOString();
    const id = `_${randomBytes(16).toString('hex')}`;
    const decale = mensonge === 'expire' ? -3_600_000 : 0;
    const inr = mensonge === 'autre_demande' ? `_${randomBytes(20).toString('hex')}` : demande.id;
    const inResponseTo = mensonge === 'sans_demande' ? '' : ` InResponseTo="${inr}"`;
    const emetteur = mensonge === 'emetteur' ? 'https://pirate.test' : `${base}/entite`;
    const nom = mensonge === 'adresse' ? 'jean@client.test' : mensonge === 'commentaire' ? `${xml(qui)}<!---->-suite` : xml(qui);
    const format = mensonge === 'ephemere' ? 'transient' : 'persistent';
    const assertion = (aid: string) =>
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${aid}" Version="2.0" IssueInstant="${t(decale)}"><saml:Issuer>${emetteur}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:${format}">${nom}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${t(decale + 300_000)}" Recipient="${xml(demande.acs)}"${inResponseTo}/></saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${t(decale - 5_000)}" NotOnOrAfter="${t(decale + 300_000)}"><saml:AudienceRestriction><saml:Audience>${xml(mensonge === 'audience' ? 'https://app.veridian.site/saml/une-autre' : demande.sp)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${t(decale)}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion>`;
    const corps = assertion(id) + (mensonge === 'deux_assertions' ? assertion(`_${randomBytes(16).toString('hex')}`) : '');
    let doc = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_${randomBytes(16).toString('hex')}" Version="2.0" IssueInstant="${t(decale)}" Destination="${xml(demande.acs)}"${inResponseTo}><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${emetteur}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${corps}</samlp:Response>`;
    if (mensonge !== 'sans_signature') {
      const sha1 = mensonge === 'sha1';
      const s = new SignedXml({
        privateKey: mensonge === 'signature' ? autre.cle : vrai.cle,
        publicCert: vrai.cert,
        signatureAlgorithm: sha1 ? 'http://www.w3.org/2000/09/xmldsig#rsa-sha1' : 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
        canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      });
      s.addReference({ xpath: `//*[@ID='${id}']`, transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: sha1 ? 'http://www.w3.org/2000/09/xmldsig#sha1' : 'http://www.w3.org/2001/04/xmlenc#sha256' });
      s.computeSignature(doc, { location: { reference: `//*[@ID='${id}']/*[local-name(.)='Issuer']`, action: 'after' } });
      doc = s.getSignedXml();
    }
    if (mensonge === 'apres_signature') doc = doc.replace(`>${xml(qui)}<`, '>quelqu-un-d-autre<');
    return Buffer.from(doc).toString('base64');
  };

  const lire = (u: URL) => {
    const demande = inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest') ?? '', 'base64')).toString('utf8');
    const attr = (n: string) => demande.match(new RegExp(`\\b${n}="([^"]+)"`))?.[1] ?? '';
    return { id: attr('ID'), acs: attr('AssertionConsumerServiceURL'), sp: demande.match(/Issuer[^>]*>([^<]+)</)?.[1] ?? '', brut: demande };
  };
  const serveur = createServer((req, res) => {
    const u = new URL(req.url ?? '/', base);
    if (u.pathname !== '/sso') { res.writeHead(404); return res.end(); }
    demandes += 1;
    const d = lire(u);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<form method="post" action="${xml(d.acs)}"><input type="hidden" name="SAMLResponse" value="${repondre(d)}"></form><script>document.forms[0].submit()</script>`);
  });
  await new Promise<void>((ok, ko) => { serveur.once('error', ko); serveur.listen(0, hote, ok); });
  base = `http://${hote}:${(serveur.address() as { port: number }).port}`;
  return {
    issuer: `${base}/entite`,
    sso: `${base}/sso`,
    certificat: vrai.cert,
    autreCertificat: autre.cert,
    dire: (x: string) => { qui = x; },
    mentir: (x: MensongeSaml) => { mensonge = x; },
    demandes: () => demandes,
    lire,
    repondre,
    fermer: () => new Promise<void>((ok) => { serveur.closeAllConnections(); serveur.close(() => ok()); }),
  };
}
