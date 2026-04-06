import {
  Users,
  Mail,
  BarChart3,
  Zap,
  Target,
  TrendingUp,
  Database,
  Send,
  Filter,
} from "lucide-react"
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import Image from "next/image"

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

        {/* Bloc 2: CRM Features - Service #1 du MVP */}
        <div className="mb-20">
          <h3 className="mb-6 flex items-center gap-2 text-2xl font-semibold text-foreground">
            <Database className="size-6" />
            CRM Intelligent
          </h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-6">
            {/* Feature CRM 1: Gestion des contacts */}
            <Card className="bg-gradient-to-t from-primary/5 to-card">
              <CardHeader className="relative">
                <div className="absolute right-4 top-4">
                  <Users className="size-8 text-muted-foreground/20" />
                </div>
                <CardTitle className="text-xl text-foreground">Gestion des contacts</CardTitle>
                <CardDescription className="mt-2">
                  Centralisez toutes vos données clients. Historique complet, notes, tags personnalisés.
                </CardDescription>
              </CardHeader>
              <CardFooter className="text-sm text-muted-foreground">
                Base de données illimitée en freemium
              </CardFooter>
            </Card>

            {/* Feature CRM 2: Pipeline de ventes */}
            <Card className="bg-gradient-to-t from-primary/5 to-card">
              <CardHeader className="relative">
                <div className="absolute right-4 top-4">
                  <Target className="size-8 text-muted-foreground/20" />
                </div>
                <CardTitle className="text-xl text-foreground">Pipeline de ventes</CardTitle>
                <CardDescription className="mt-2">
                  Visualisez votre pipeline en temps réel. Drag & drop, étapes personnalisables, prévisions.
                </CardDescription>
              </CardHeader>
              <CardFooter className="text-sm text-muted-foreground">
                Kanban view inclus
              </CardFooter>
            </Card>

            {/* Feature CRM 3: Analytics */}
            <Card className="bg-gradient-to-t from-primary/5 to-card">
              <CardHeader className="relative">
                <div className="absolute right-4 top-4">
                  <BarChart3 className="size-8 text-muted-foreground/20" />
                </div>
                <CardTitle className="text-xl text-foreground">Analytics avancés</CardTitle>
                <CardDescription className="mt-2">
                  Tableaux de bord personnalisables. Métriques clés, rapports exportables, insights IA.
                </CardDescription>
              </CardHeader>
              <CardFooter className="text-sm text-muted-foreground">
                Rapports en temps réel
              </CardFooter>
            </Card>
          </div>

          {/* Image CRM - Screenshot de l'interface */}
          <div className="mt-12">
            <div className="relative overflow-hidden rounded-xl border bg-card shadow-2xl dark:shadow-[0_0_50px_0px_var(--primary)] ring-1 ring-black/5 dark:ring-primary/50">
              <Image
                src="/landing/crm-interface.webp"
                alt="Interface CRM - Gestion des contacts et pipeline de ventes"
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
                  Créez des séquences d'emails intelligentes. Déclencheurs personnalisés, A/B testing intégré.
                </CardDescription>
              </CardHeader>
              <CardFooter className="text-sm text-muted-foreground">
                Templates prêts à l'emploi
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
                <CardTitle className="text-xl text-foreground">Tracking & Analytics</CardTitle>
                <CardDescription className="mt-2">
                  Suivez chaque interaction. Taux d'ouverture, clics, conversions, ROI en temps réel.
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
