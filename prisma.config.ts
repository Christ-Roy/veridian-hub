// Prisma 7 config — déclare la connection URL et l'adapter Postgres.
// Remplace l'ancien `datasource.url = env("DATABASE_URL")` du schema.
// Voir https://pris.ly/d/prisma7-client-config

import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  // Connection URL pour les commandes CLI (migrate, studio, db push).
  // Format attendu : postgresql://veridian:<password>@<host>:5432/veridian?schema=hub_app
  // Accès interne Docker uniquement — ne PAS exposer à l'hôte.
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
