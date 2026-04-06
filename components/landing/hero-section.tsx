import { ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Image from "next/image";
import Link from "next/link";

export function HeroSection() {
  return (
    <section className="relative overflow-hidden px-4 py-20 lg:px-6 lg:py-32">
      <div className="relative mx-auto max-w-6xl">
        <div className="flex flex-col items-center text-center">
          <Badge variant="outline" className="mb-8 flex gap-2 rounded-lg px-4 py-1.5">
            <Sparkles className="size-4" />
            <span className="text-sm">Plateforme Business All-in-One</span>
          </Badge>

          <h1 className="mb-6 text-4xl font-bold tracking-tight text-foreground sm:text-5xl md:text-6xl lg:text-7xl">
            Connectez Twenty CRM & Notifuse
            <br />
            <span className="text-foreground">en une seule plateforme</span>
          </h1>

          <p className="mb-10 max-w-2xl text-lg text-muted-foreground sm:text-xl">
            Gérez vos clients avec un <strong className="text-foreground">CRM intelligent</strong> et
            automatisez vos campagnes email. Tout ce dont vous avez besoin pour développer votre business,
            dans une seule plateforme.
          </p>

          <div className="flex flex-col gap-4 sm:flex-row">
            <Button asChild size="lg" className="gap-2 px-8 text-base">
              <Link href="/signup">
                Commencer gratuitement
                <ArrowRight className="size-5" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="px-8 text-base text-foreground">
              <Link href="/pricing">
                Découvrir les fonctionnalités
              </Link>
            </Button>
          </div>

          <div className="mt-16 grid w-full grid-cols-1 gap-4 sm:grid-cols-3 md:gap-6">
            <div className="rounded-lg border bg-gradient-to-t from-primary/5 to-card p-6 text-center">
              <div className="text-3xl font-bold tabular-nums text-foreground">10K+</div>
              <div className="mt-1 text-sm text-muted-foreground">Utilisateurs actifs</div>
            </div>

            <div className="rounded-lg border bg-gradient-to-t from-primary/5 to-card p-6 text-center">
              <div className="text-3xl font-bold tabular-nums text-foreground">500K+</div>
              <div className="mt-1 text-sm text-muted-foreground">Emails envoyés/mois</div>
            </div>

            <div className="rounded-lg border bg-gradient-to-t from-primary/5 to-card p-6 text-center">
              <div className="text-3xl font-bold tabular-nums text-foreground">98%</div>
              <div className="mt-1 text-sm text-muted-foreground">Satisfaction client</div>
            </div>
          </div>

          <div className="mt-20 w-full">
            <div className="relative overflow-hidden rounded-xl border bg-card shadow-2xl dark:shadow-[0_0_50px_0px_var(--primary)] ring-1 ring-black/5 dark:ring-primary/50">
              <Image
                src="/landing/hero-dashboard.webp"
                alt="Dashboard de la plateforme - Interface CRM et Mail Automation"
                width={1920}
                height={1080}
                priority
                className="w-full"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
