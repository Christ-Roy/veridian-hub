'use client';

import { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import type { LiensInstallation } from '@/lib/mcp/liens-installation';

function Copier({ texte, libelle }: { texte: string; libelle: string }) {
  const [fait, setFait] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(texte);
          setFait(true);
          toast.success(`${libelle} copié`);
          setTimeout(() => setFait(false), 2000);
        } catch {
          toast.error('Copie impossible : sélectionnez le texte à la main');
        }
      }}
    >
      {fait ? <Check className="size-4" /> : <Copy className="size-4" />}
      {libelle}
    </Button>
  );
}

function Lien({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Button asChild size="sm">
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
        <ExternalLink className="size-4" />
      </a>
    </Button>
  );
}

/**
 * Une seule connexion pour toutes les apps Veridian : l'assistant ouvre la porte MCP du Hub, puis
 * l'utilisateur se connecte et autorise. Claude, Cursor et VS Code ont un lien qui préremplit ;
 * ChatGPT n'en a pas, on donne l'adresse à coller.
 */
export function ConnecterAssistant({ liens }: { liens: LiensInstallation }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Lien href={liens.claude}>Ajouter à Claude</Lien>
        <Lien href={liens.chatgpt}>Ouvrir ChatGPT</Lien>
        <Lien href={liens.cursor}>Ajouter à Cursor</Lien>
        <Lien href={liens.vscode}>Ajouter à VS Code</Lien>
      </div>
      <p className="text-sm text-muted-foreground">
        Claude, Cursor et VS Code s&apos;ouvrent avec Veridian déjà renseigné : confirmez, puis connectez-vous et
        autorisez. Dans ChatGPT (Paramètres, Plugins) : ajoutez un serveur MCP, collez l&apos;adresse ci-dessous
        et choisissez l&apos;authentification OAuth. Si l&apos;option n&apos;apparaît pas, activez le mode
        développeur dans Paramètres, Sécurité et connexion.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-muted px-2 py-1 text-xs break-all">{liens.url}</code>
        <Copier texte={liens.url} libelle="Adresse" />
        <Copier texte={liens.claudeCode} libelle="Commande Claude Code" />
      </div>
    </div>
  );
}
