/** Atelier « Mon IA » : isolation entre clients et figeage du binaire (docs/MON-IA.md). */
import { describe, expect, it } from 'vitest';

// @ts-expect-error module .mjs sans déclaration de types
import { adresseDeConnexion, cheminBinaire, clientAutorise, dansReseau, surReseauAtelier, codeValide, dossierClient, environnementBinaire, hoteAutorise, optionsBinaire, signatureValide, signer } from '../../atelier/regles.mjs';

const A = '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
const B = '7aa7d4b4-3515-4101-9119-5bc2e6c9a651';

describe('un dossier par client', () => {
  it('stable pour un client, distinct entre deux clients, sous la racine', () => {
    expect(dossierClient('/donnees', A)).toBe(dossierClient('/donnees', A));
    expect(dossierClient('/donnees', A)).not.toBe(dossierClient('/donnees', B));
    expect(dossierClient('/donnees', A).startsWith('/donnees/')).toBe(true);
  });

  it('refuse un identifiant qui pourrait sortir du dossier', () => {
    for (const x of ['../etc', '', 'robert', `${A}/../${B}`]) expect(() => dossierClient('/donnees', x)).toThrow();
  });
});

describe('le binaire est figé : aucun outil, aucun réglage, nos seuls outils', () => {
  it('environnement construit de zéro, connecteurs claude.ai et mémoire coupés', () => {
    process.env.SECRET_DE_LA_FLOTTE = 'ne-doit-pas-passer';
    const e = environnementBinaire('/donnees/x');
    expect(e).not.toHaveProperty('SECRET_DE_LA_FLOTTE');
    expect(e).not.toHaveProperty('ATELIER_SECRET');
    expect(e).toMatchObject({ CLAUDE_CONFIG_DIR: '/donnees/x/config', ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });

  it('tools vide, settingSources vide, MCP strict, reprise par la session du Hub', () => {
    const o = optionsBinaire('/donnees/x', { type: 'sdk' }, { sessionId: 's1', reprise: true });
    expect(o.tools).toEqual([]);
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(Object.keys(o.mcpServers)).toEqual(['veridian']);
    expect(o.allowedTools).not.toContain('mcp__veridian__executer_outil');
    expect(o.resume).toBe('s1');
    expect(optionsBinaire('/donnees/x', {}, { sessionId: 's2', reprise: false })).toMatchObject({ sessionId: 's2' });
    expect(o).not.toHaveProperty('permissionMode');
  });
});

describe('signature Hub ↔ atelier', () => {
  const S = 's'.repeat(40);
  it('valide, puis refusée si le corps, le secret ou l\'heure changent', () => {
    const { ts, sig } = signer(S, '{"a":1}');
    expect(signatureValide(S, ts, sig, '{"a":1}')).toBe(true);
    expect(signatureValide(S, ts, sig, '{"a":2}')).toBe(false);
    expect(signatureValide('t'.repeat(40), ts, sig, '{"a":1}')).toBe(false);
    expect(signatureValide(S, ts, sig, '{"a":1}', Number(ts) + 6 * 60_000)).toBe(false);
  });
});

describe('connexion du client', () => {
  it('ne retient que l\'adresse de connexion d\'Anthropic', () => {
    const sortie = 'Opening browser…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&state=x\nPaste code here if prompted >';
    expect(adresseDeConnexion(sortie)).toBe('https://claude.com/cai/oauth/authorize?code=true&state=x');
    expect(adresseDeConnexion('visit: https://pirate.example/oauth')).toBeNull();
  });

  it('le code collé n\'a ni espace ni retour à la ligne', () => {
    expect(codeValide('abcDEF123456#state789')).toBe(true);
    expect(codeValide('abc\nclaude --dangerously')).toBe(false);
    expect(codeValide('court')).toBe(false);
  });
});

describe('sortie réseau du binaire : Anthropic seulement', () => {
  it('Anthropic oui ; tailnet, réseau interne, IP brute, Hub et sous-domaines piégés non', () => {
    for (const h of ['api.anthropic.com', 'claude.ai', 'platform.claude.com', 'CLAUDE.AI']) expect(hoteAutorise(h), h).toBe(true);
    for (const h of ['100.108.136.89', 'contabo-bastion', '172.26.64.1', 'app.veridian.site', 'api.anthropic.com.pirate.io', 'evil-claude.ai', '', undefined]) {
      expect(hoteAutorise(h), String(h)).toBe(false);
    }
  });
});

describe('un atelier, un seul client', () => {
  it('fermé par défaut ; refuse un autre client ; refuse une liste de plusieurs', () => {
    expect(clientAutorise('', A)).toBe(false);
    expect(clientAutorise(undefined, A)).toBe(false);
    expect(clientAutorise(A, A)).toBe(true);
    expect(clientAutorise(A, B)).toBe(false);
    expect(clientAutorise(`${A},${B}`, A)).toBe(false);
  });
});

describe('fermé hors du réseau atelier (pare-feu de sortie de rise)', () => {
  const iface = (address: string, internal = false) => ({ eth0: [{ address, family: 'IPv4', internal }] });

  it('ouvert seulement sur 172.31.250.0/24', () => {
    expect(surReseauAtelier(iface('172.31.250.17'))).toBe(true);
  });

  it('pont Nomad ordinaire, tailnet, hôte, boucle locale ou aucune interface : fermé', () => {
    for (const ip of ['172.26.64.12', '172.31.251.2', '100.96.29.49', '10.0.0.5', '192.168.1.2']) expect(surReseauAtelier(iface(ip)), ip).toBe(false);
    expect(surReseauAtelier(iface('172.31.250.1', true))).toBe(false);
    expect(surReseauAtelier({})).toBe(false);
    expect(surReseauAtelier(undefined)).toBe(false);
    expect(surReseauAtelier({ eth0: [{ address: 'fe80::1', family: 'IPv6', internal: false }] })).toBe(false);
  });

  it('calcul de plage : bornes et adresses illisibles', () => {
    expect(dansReseau('172.31.250.0', '172.31.250.0/24')).toBe(true);
    expect(dansReseau('172.31.250.255', '172.31.250.0/24')).toBe(true);
    expect(dansReseau('172.31.249.255', '172.31.250.0/24')).toBe(false);
    for (const ip of ['172.31.250', '172.31.250.300', 'abc', '']) expect(dansReseau(ip, '172.31.250.0/24'), ip).toBe(false);
    expect(dansReseau('172.31.250.4', '0.0.0.0/0')).toBe(false);
  });
});

describe('binaire embarqué par le SDK, jamais le PATH', () => {
  const resoudre = (dispo: string[]) => (m: string) => {
    if (!dispo.includes(m)) throw new Error('MODULE_NOT_FOUND');
    return `/opt/atelier/node_modules/${m}`;
  };
  const existe = () => true;

  it('Alpine : la variante musl d\'abord', () => {
    const r = resoudre(['@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude', '@anthropic-ai/claude-agent-sdk-linux-x64/claude']);
    expect(cheminBinaire(r, existe, 'x64')).toBe('/opt/atelier/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude');
  });

  it('variante glibc si musl manque ; rien du tout : null, jamais « claude » du PATH', () => {
    expect(cheminBinaire(resoudre(['@anthropic-ai/claude-agent-sdk-linux-x64/claude']), existe, 'x64')).toBe('/opt/atelier/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude');
    expect(cheminBinaire(resoudre([]), existe, 'x64')).toBeNull();
  });

  it('résolu mais absent du disque : null', () => {
    expect(cheminBinaire(resoudre(['@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude']), () => false, 'x64')).toBeNull();
  });
});
