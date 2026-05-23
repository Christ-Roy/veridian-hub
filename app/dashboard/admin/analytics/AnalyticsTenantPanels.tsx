'use client';

import { useState } from 'react';
import { ChevronDown, Plus, Link2 } from 'lucide-react';

import type { AnalyticsTenant } from '@/lib/analytics/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Panneaux d'action d'un tenant Analytics : "Ajouter un site" et "Attacher
 * GSC". Extraits en client component car ils ont besoin d'un état de
 * dépliement (anciennement `<details>` natifs) et d'un `<Select>` shadcn
 * contrôlé. Les formulaires restent des `<form action={serverAction}>` —
 * les server actions sont passées en props depuis la page (Server Component).
 *
 * Note Select GSC : `<Select>` shadcn n'émet pas de champ natif dans un
 * `<form>`. On miroite la valeur choisie dans un `<input type="hidden">`
 * pour que la server action reçoive bien `siteId`.
 */

interface Props {
  tenant: AnalyticsTenant;
  createSiteAction: (formData: FormData) => Promise<void>;
  attachGscAction: (formData: FormData) => Promise<void>;
}

export function AnalyticsTenantPanels({
  tenant,
  createSiteAction,
  attachGscAction,
}: Props) {
  const [siteOpen, setSiteOpen] = useState(false);
  const [gscOpen, setGscOpen] = useState(false);
  const sites = tenant.sites ?? [];
  const [gscSiteId, setGscSiteId] = useState(sites[0]?.id ?? '');

  return (
    <div className="space-y-2 pt-1">
      {/* Ajouter un site */}
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-primary"
          onClick={() => setSiteOpen((v) => !v)}
          aria-expanded={siteOpen}
        >
          <ChevronDown
            className={`transition-transform ${siteOpen ? '' : '-rotate-90'}`}
          />
          <Plus />
          Ajouter un site
        </Button>
        {siteOpen && (
          <form
            action={createSiteAction}
            className="grid gap-2 md:grid-cols-4 mt-2"
          >
            <input type="hidden" name="tenantId" value={tenant.id} />
            <Input
              name="domain"
              placeholder="tramtech.fr"
              required
              className="h-9 text-sm"
            />
            <Input
              name="name"
              placeholder="Site vitrine"
              required
              className="h-9 text-sm"
            />
            <div className="hidden md:block" />
            <Button type="submit" size="sm">
              Créer le site
            </Button>
          </form>
        )}
      </div>

      {/* Attacher GSC */}
      {sites.length > 0 && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-primary"
            onClick={() => setGscOpen((v) => !v)}
            aria-expanded={gscOpen}
          >
            <ChevronDown
              className={`transition-transform ${gscOpen ? '' : '-rotate-90'}`}
            />
            <Link2 />
            Attacher GSC à un site
          </Button>
          {gscOpen && (
            <form
              action={attachGscAction}
              className="grid gap-2 md:grid-cols-4 mt-2"
            >
              <input type="hidden" name="siteId" value={gscSiteId} />
              <Select value={gscSiteId} onValueChange={setGscSiteId}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Choisir un site" />
                </SelectTrigger>
                <SelectContent>
                  {sites.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.domain}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                name="propertyUrl"
                placeholder="sc-domain:tramtech.fr"
                required
                className="h-9 text-sm md:col-span-2"
              />
              <Button type="submit" size="sm">
                Attacher
              </Button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
