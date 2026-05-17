import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Centre d\'aide | Guides Veridian',
  description: 'Besoin d\'aide ? Apprenez à configurer vos workflows, connecter vos outils SaaS et optimiser votre productivité avec nos guides complets.',
  openGraph: {
    title: 'Centre d\'aide Veridian | Guides et Intégrations',
    description: 'Besoin d\'aide ? Apprenez à configurer vos workflows, connecter vos outils SaaS et optimiser votre productivité avec nos guides complets.'
  }
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'Comment automatiser mes emails avec Notifuse ?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Notifuse est intégré nativement à Veridian. Consultez la documentation Notifuse pour créer vos premières campagnes d\'email automation et séquences marketing.'
      }
    },
    {
      '@type': 'Question',
      name: 'Comment qualifier mes leads avec Prospection ?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Le module Prospection Veridian permet de qualifier vos leads commerciaux et de suivre votre pipeline depuis votre dashboard Veridian.'
      }
    }
  ]
};

export default function DocsPage() {
    return (
        <>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <div className="min-h-screen gradient-bg py-12 px-4 sm:px-6 lg:px-8">
            <div className="max-w-4xl mx-auto">
                <h1 className="page-title mb-4">Guides Veridian</h1>
                <p className="text-lg text-muted-foreground mb-12">
                    Configurez vos outils et optimisez votre productivité avec nos guides complets.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    {/* Notifuse */}
                    <div className="feature-card">
                        <h2 className="section-title mb-3">
                            Notifuse
                        </h2>
                            <p className="text-muted-foreground mb-6">
                                Consultez la documentation à jour et complète de Notifuse.
                            </p>
                            <a
                                href="https://docs.notifuse.com"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-block bg-primary text-primary-foreground hover:bg-primary/90 font-medium py-2 px-4 rounded transition"
                            >
                                Accéder à Notifuse Docs →
                            </a>
                        </div>

                    {/* Prospection */}
                    <div className="feature-card">
                        <h2 className="section-title mb-3">
                            Prospection
                        </h2>
                            <p className="text-muted-foreground mb-6">
                                Apprenez à qualifier vos leads et piloter votre pipeline commercial.
                            </p>
                            <a
                                href="/dashboard"
                                className="inline-block bg-primary text-primary-foreground hover:bg-primary/90 font-medium py-2 px-4 rounded transition"
                            >
                                Accéder à votre Prospection →
                            </a>
                        </div>
                </div>
            </div>
        </div>
        </>
    );
}
