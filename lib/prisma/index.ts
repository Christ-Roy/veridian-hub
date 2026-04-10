// Singleton Prisma Client pour le Hub.
// Pattern standard Next.js pour éviter de recréer un client à chaque reload
// en dev (HMR).
//
// Prisma 7 exige un driver adapter explicite (pas de datasource url dans le
// schema). On utilise `@prisma/adapter-pg` qui wrap `pg` côté Node.

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  // En build time (Next.js SSG / CI sans DB), DATABASE_URL peut être absent.
  // On instancie sans adapter — les appels réels échoueront à l'exécution,
  // pas au démarrage. En prod, DATABASE_URL est toujours injecté par docker-compose.
  if (!connectionString) {
    return new PrismaClient({
      log: ['error'],
    });
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

/**
 * Proxy lazy : le client Prisma n'est instancié qu'au premier accès (runtime),
 * pas à l'import. Permet à Next.js de collecter les routes au build sans
 * ouvrir de connexion Postgres.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    if (!globalForPrisma.prisma) {
      globalForPrisma.prisma = createClient();
    }
    const value = Reflect.get(globalForPrisma.prisma, prop, receiver);
    return typeof value === 'function' ? value.bind(globalForPrisma.prisma) : value;
  },
});
