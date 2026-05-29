import { SidebarTrigger } from '@/components/ui/sidebar';
import { VeridianHubLogo } from '@/components/icons/VeridianHubLogo';

/**
 * Barre supérieure mobile du dashboard : bouton hamburger (ouvre la sidebar
 * en drawer off-canvas) + logo Veridian. Visible uniquement < lg ; sur
 * desktop la sidebar est affichée en permanence, pas besoin de trigger.
 */
export function MobileTopbar() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card/70 backdrop-blur-md px-4 lg:hidden">
      <SidebarTrigger className="-ml-1" />
      <VeridianHubLogo size="sm" href="/dashboard" />
    </header>
  );
}

export default MobileTopbar;
