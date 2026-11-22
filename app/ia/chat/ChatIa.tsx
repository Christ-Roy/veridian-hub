'use client';

// Assistant Veridian : la fenêtre de chat commune à toutes les apps (docs/MON-IA.md). Toute écriture
// s'affiche ici avec son outil et ses paramètres, et ne part qu'après « Autoriser ».
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

type Props = { app: string; tenantId: string; sessionId: string | null };

const MESSAGES_ERREUR: Record<string, string> = {
  chat_desactive: "L'assistant n'est pas allumé pour cette app. Allumez-le dans votre espace Veridian, rubrique Assistants IA.",
  pas_de_branchement: "Aucune IA n'est branchée. Branchez la vôtre dans votre espace Veridian, rubrique Assistants IA.",
  plafond: 'Trop de questions en peu de temps : réessayez dans un instant.',
  session_inconnue: 'Cette conversation ne peut pas être reprise ici.',
};

export function ChatIa({ app, tenantId, sessionId }: Props) {
  const session = useRef<string | null>(sessionId);
  const [texte, setTexte] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);

  const { messages, setMessages, sendMessage, status, addToolApprovalResponse } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/ia/chat',
      body: () => ({ app, tenantId, sessionId: session.current }),
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (e) => {
      const code = (() => {
        try {
          return (JSON.parse(e.message) as { error?: string }).error;
        } catch {
          return undefined;
        }
      })();
      setErreur((code && MESSAGES_ERREUR[code]) || "L'assistant n'a pas pu répondre. Réessayez.");
    },
  });

  // Fil existant : relu dans l'app, par le Hub.
  useEffect(() => {
    if (!sessionId) return;
    const q = new URLSearchParams({ app, tenant: tenantId, session: sessionId });
    fetch(`/api/ia/fil?${q}`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((j: { messages?: UIMessage[] }) => setMessages(j.messages ?? []))
      .catch(() => undefined);
  }, [app, tenantId, sessionId, setMessages]);

  // L'identifiant de session vient du Hub (métadonnée du premier message) ; l'app hôte le garde pour
  // rouvrir le fil.
  useEffect(() => {
    for (const m of messages) {
      const id = (m.metadata as { sessionId?: string } | undefined)?.sessionId;
      if (id && id !== session.current) {
        session.current = id;
        // Seulement vers l'app hôte, jamais vers une origine quelconque.
        const hote = (() => {
          try {
            return new URL(document.referrer).origin;
          } catch {
            return null;
          }
        })();
        if (hote && /^https:\/\/([a-z0-9-]+\.)*app\.veridian\.site$/.test(hote)) {
          window.parent?.postMessage({ type: 'veridian-ia-session', sessionId: id }, hote);
        }
      }
    }
  }, [messages]);

  const occupe = status === 'submitted' || status === 'streaming';

  // Moteur abonnement : l'approbation repart à l'atelier par le Hub, pendant que le tour attend.
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  async function decider(id: string, ok: boolean) {
    setDecisions((d) => ({ ...d, [id]: ok }));
    await fetch('/api/ia/abonnement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approbation', id, ok }) });
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="border-b border-border px-4 py-2 text-sm font-medium">Assistant Veridian</header>
      <div className="flex-1 space-y-3 overflow-y-auto p-4 text-sm" aria-live="polite">
        {messages.length === 0 && <p className="text-muted-foreground">Posez une question sur vos données.</p>}
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'text-right' : ''}>
            {m.parts.map((p, i) => {
              if (p.type === 'text') {
                return (
                  <p
                    key={i}
                    className={
                      m.role === 'user'
                        ? 'inline-block whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-primary-foreground'
                        : 'whitespace-pre-wrap'
                    }
                  >
                    {p.text}
                  </p>
                );
              }
              if (p.type === 'data-approbation') {
                const d = (p as unknown as { data: { id: string; outil: string; arguments: unknown } }).data;
                const reponse = decisions[d.id];
                return (
                  <div key={i} className="space-y-2 rounded-lg border border-border p-3" role="group" aria-label="Autorisation demandée">
                    <p className="font-medium">L&apos;assistant veut modifier vos données</p>
                    <p className="text-muted-foreground">Outil : {d.outil}</p>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{JSON.stringify(d.arguments ?? {}, null, 2)}</pre>
                    {reponse === undefined ? (
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => decider(d.id, true)}>
                          Autoriser
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => decider(d.id, false)}>
                          Refuser
                        </Button>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">{reponse ? 'Autorisé' : 'Refusé'}</p>
                    )}
                  </div>
                );
              }
              if (p.type.startsWith('tool-')) {
                const t = p as unknown as { state: string; input?: { nom?: string; arguments?: unknown }; approval?: { id: string } };
                if (t.state === 'approval-requested' && t.approval) {
                  return (
                    <div key={i} className="space-y-2 rounded-lg border border-border p-3" role="group" aria-label="Autorisation demandée">
                      <p className="font-medium">L&apos;assistant veut modifier vos données</p>
                      <p className="text-muted-foreground">Outil : {t.input?.nom ?? 'inconnu'}</p>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                        {JSON.stringify(t.input?.arguments ?? {}, null, 2)}
                      </pre>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => addToolApprovalResponse({ id: t.approval!.id, approved: true })}>
                          Autoriser
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => addToolApprovalResponse({ id: t.approval!.id, approved: false })}>
                          Refuser
                        </Button>
                      </div>
                    </div>
                  );
                }
                return (
                  <p key={i} className="text-xs text-muted-foreground">
                    {t.state === 'output-available' ? 'Données consultées' : 'Recherche dans vos apps…'}
                  </p>
                );
              }
              return null;
            })}
          </div>
        ))}
        {erreur && <p className="text-destructive">{erreur}</p>}
      </div>
      <form
        className="flex gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!texte.trim() || occupe) return;
          setErreur(null);
          void sendMessage({ text: texte.trim() });
          setTexte('');
        }}
      >
        <input
          className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm"
          value={texte}
          onChange={(e) => setTexte(e.target.value)}
          placeholder="Votre question"
          aria-label="Votre question"
        />
        <Button type="submit" size="sm" disabled={occupe || !texte.trim()}>
          Envoyer
        </Button>
      </form>
    </div>
  );
}
