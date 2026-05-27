import {
  Users,
  BarChart3,
  Zap,
  Target,
  TrendingUp,
  Database,
  Send,
  Filter,
  Sparkles,
  Download,
  ArrowRight,
} from "lucide-react"
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Image from "next/image"
import Link from "next/link"

/**
 * FEATURES SECTION - Présentation des services MVP
 *
 * Objectif: Détailler les 2 services principaux (CRM + Mail Automation)
 *
 * Structure:
 * 1. Titre de section - Introduction aux services
 * 2. Grid de features CRM - 3 fonctionnalités principales
 * 3. Grid de features Mail Automation - 3 fonctionnalités principales
 *
 * Design: Utilise le même style que section-cards.tsx du dashboard
 * (gradient from-primary/5 to-card, badges, structure responsive)
 */
export function FeaturesSection() {
  return (
    <section className="px-4 py-20 lg:px-6 lg:py-24">
      <div className="mx-auto max-w-6xl">
        {/* Bloc 1: Titre de la section - Introduit les services */}
        <div className="mb-16 text-center">
          <Badge variant="outline" className="mb-4">
            Nos Services
          </Badge>
          <h2 className="mb-4 text-3xl font-bold tracking-tight text-foreground">
            Tout ce dont vous avez besoin
          </h2>
          <p className="mx-auto max-w-2xl text-lg text-muted-foreground">
            Deux outils puissants pour développer votre business, disponibles en freemium
          </p>
        </div>

        {/* Bloc 2: CRM Features - Inclus dans Pro & Business (livré en staging, prod imminent) */}
        <div className="mb-20">
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <h3 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
              <Database className="size-6" />
              CRM Intelligent
            </h3>
            <Badge variant="secondary" className="text-xs">
              Inclus dans Veridian Pro &amp; Business
            </Badge>
            <Badge variant="outline" className="text-xs text-muted-foreground">
              Disponible sur staging — lancement prod imminent
            </Badge>
          </div>
          <p className="mb-6 max-w-3xl text-muted-foreground">
            Pipeline Kanban, contacts unifiés, assistant IA et import direct depuis Veridian Prospection — un CRM pensé pour transformer vos leads en clients sans changer d'outil.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-6">
            {/* Feature CRM 1: Pipeline Kanban */}
            <Card className="bg-gradient-to-t from-primary/5 to-card">
              <CardHeader className="relative">
                <div className="absolute right-4 top-4">
                  <Target className="size-8 text-muted-foreground/20" />
                </div>
                <CardTitle className="text-xl text-foreground">Pipeline Kanban</CardTitle>
                <CardDescription className="mt-2">
                  Visualisez vos deals en colonnes drag &amp; drop. Étapes personnalisables, prévisions et relances automatisées.
                </CardDescription>
              </CardHeader>
              <CardFooter className="text-sm text-muted-foreground">
                Vue Kanban illimitée
              </CardFooter>
            </Card>

            {/* Feature CRM 2: Contacts + AI assistant */}
            <Card className="bg-gradient-to-t from-primary/5 to-card">
              <CardHeader className="relative">
                <div className="absolute right-4 top-4">
                  <Sparkles className="size-8 text-muted-foreground/20" />
                </div>
                <CardTitle className="text-xl text-foreground">Contacts &amp; assistant IA</CardTitle>
                <CardDescription className="mt-2">
                  Centralisez vos contacts, historique et notes. L'assistant IA résume vos échanges et suggère les prochaines actions.
                </CardDescription>
              </CardHeader>
              <CardFooter className="text-sm text-muted-foreground">
                Contacts illimités
              </CardFooter>
            </Card>

            {/* Feature CRM 3: Import depuis Prospection */}
            <Card className="bg-gradient-to-t from-primary/5 to-card">
              <CardHeader className="relative">
                <div className="absolute right-4 top-4">
                  <Download className="size-8 text-muted-foreground/20" />
                </div>
                <CardTitle className="text-xl text-foreground">Import depuis Prospection</CardTitle>
                <CardDescription className="mt-2">
                  Vos leads qualifiés depuis Veridian Prospection arrivent directement dans le pipeline. Zéro copier-coller.
                </CardDescription>
              </CardHeader>
              <CardFooter className="text-sm text-muted-foreground">
                Sync native cross-app
              </CardFooter>
            </Card>
          </div>

          {/* CTA CRM — pointe vers l'offre payante (Pro & Business) */}
          <div className="mt-8 flex justify-center">
            <Button asChild size="lg" variant="outline">
              <Link href="/pricing#crm">
                Découvrir l&apos;offre CRM
                <ArrowRight className="ml-2 size-4" />
              </Link>
            </Button>
          </div>

          {/* Image CRM - Screenshot de l'interface */}
          <div className="mt-12">
            <div className="relative overflow-hidden rounded-xl border bg-card shadow-2xl dark:shadow-[0_0_50px_0px_var(--primary)] ring-1 ring-black/5 dark:ring-primary/50">
              <Image
                src="/landing/crm-interface.webp"
                alt="Interface CRM Veridian — pipeline Kanban et gestion des contacts"
                width={1600}
                height={900}
                className="w-full"
              />
            </div>
          </div>
        </div>

        {/* Bloc 3: Mail Automation Features - Service #2 du MVP */}
        <div>
          <h3 className="mb-6 flex items-center gap-2 text-2xl font-semibold text-foreground">
            <Zap className="size-6" />
            Mail Automation
          </h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-6">
            {/* Feature Mail 1: Campagnes automatisées */}
            <Card className="bg-gradient-to-t from-primary/5 to-card">
              <CardHeader className="relative">
                <div className="absolute right-4 top-4">
                  <Send className="size-8 text-muted-foreground/20" />
                </div>
                <CardTitle className="text-xl text-foreground">Campagnes automatisées</CardTitle>
                <CardDescription className="mt-2">
                  Créez des séquences d&apos;emails intelligentes. Déclencheurs personnalisés, A/B testing intégré.
                </CardDescription>
              </CardHeader>
              <CardFooter className="text-sm text-muted-foreground">
                Templates prêts à l&apos;emploi
              </CardFooter>
            </Card>

            {/* Feature Mail 2: Segmentation */}
            <Card className="bg-gradient-to-t from-primary/5 to-card">
              <CardHeader className="relative">
                <div className="absolute right-4 top-4">
                  <Filter className="size-8 text-muted-foreground/20" />
                </div>
                <CardTitle className="text-xl text-foreground">Segmentation avancée</CardTitle>
                <CardDescription className="mt-2">
                  Ciblez précisément vos audiences. Filtres comportementaux, scoring automatique, listes dynamiques.
                </CardDescription>
              </CardHeader>
              <CardFooter className="text-sm text-muted-foreground">
                Personnalisation poussée
              </CardFooter>
            </Card>

            {/* Feature Mail 3: Tracking */}
            <Card className="bg-gradient-to-t from-primary/5 to-card">
              <CardHeader className="relative">
                <div className="absolute right-4 top-4">
                  <TrendingUp className="size-8 text-muted-foreground/20" />
                </div>
                <CardTitle className="text-xl text-foreground">Tracking &amp; Analytics</CardTitle>
                <CardDescription className="mt-2">
                  Suivez chaque interaction. Taux d&apos;ouverture, clics, conversions, ROI en temps réel.
                </CardDescription>
              </CardHeader>
              <CardFooter className="text-sm text-muted-foreground">
                Dashboard de performance
              </CardFooter>
            </Card>
          </div>

          {/* Image Mail Automation - Screenshot de l'interface */}
          <div className="mt-12">
            <div className="relative overflow-hidden rounded-xl border bg-card shadow-2xl dark:shadow-[0_0_50px_0px_var(--primary)] ring-1 ring-black/5 dark:ring-primary/50">
              <Image
                src="/landing/mail-automation-interface.webp"
                alt="Interface Mail Automation - Éditeur de campagnes et analytics"
                width={1600}
                height={900}
                className="w-full"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
