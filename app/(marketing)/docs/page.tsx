import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Centre d\'aide | Guides Twenty CRM & Notifuse',
  description: 'Besoin d\'aide ? Apprenez à configurer vos workflows, connecter vos outils SaaS et optimiser votre productivité avec nos guides complets.',
  openGraph: {
    title: 'Centre d\'aide Veridian | Guides et Intégrations Twenty & Notifuse',
    description: 'Besoin d\'aide ? Apprenez à configurer vos workflows, connecter vos outils SaaS et optimiser votre productivité avec nos guides complets.'
  }
};

// JSON-LD Schema pour Rich Snippets Google (FAQ)
const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'Comment configurer Twenty CRM avec Veridian ?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Twenty CRM est automatiquement provisionné lors de la création de votre compte Veridian. Accédez à la documentation Twenty pour découvrir toutes les fonctionnalités disponibles.'
      }
    },
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
      name: 'Puis-je connecter Twenty CRM et Notifuse ensemble ?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Oui, Veridian centralise Twenty CRM et Notifuse sur une même plateforme. Vos contacts CRM peuvent être synchronisés avec vos listes Notifuse pour des campagnes ciblées.'
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
                <h1 className="page-title mb-4">Guides Twenty CRM & Notifuse</h1>
                <p className="text-lg text-muted-foreground mb-12">
                    Configurez vos outils et optimisez votre productivité avec nos guides complets.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    {/* Twenty CRM */}
                    <div className="feature-card">
                        <h2 className="section-title mb-3">
                            Twenty CRM
                        </h2>
                            <p className="text-muted-foreground mb-6">
                                Consultez la documentation complète de Twenty CRM.
                            </p>
                            <a
                                href="https://docs.twenty.com"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-block bg-primary text-primary-foreground hover:bg-primary/90 font-medium py-2 px-4 rounded transition"
                            >
                                Accéder à Twenty CRM Docs →
                            </a>
                        </div>

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
                </div>
            </div>
        </div>
        </>
    );
}