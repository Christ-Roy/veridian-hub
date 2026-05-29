// Seed un user de test loggable en Credentials pour le dev UI local.
// Usage: node scripts/seed-local-user.mjs
// Crée (idempotent) : ui@local.dev / password "uiuiui12"
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const EMAIL = 'ui@local.dev';
const PASSWORD = 'uiuiui12';
const NAME = 'UI Dev';

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);

  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: {},
    create: {
      id: randomUUID(),
      email: EMAIL,
      name: NAME,
      emailVerified: new Date(),
      // UUID bridge obligatoire sinon le dashboard crash sur userUuid()
      supabaseUserId: randomUUID(),
    },
  });

  // Account credentials (password = bcrypt dans access_token)
  await prisma.account.upsert({
    where: {
      provider_providerAccountId: {
        provider: 'credentials',
        providerAccountId: user.id,
      },
    },
    update: { access_token: hash },
    create: {
      userId: user.id,
      type: 'credentials',
      provider: 'credentials',
      providerAccountId: user.id,
      access_token: hash,
    },
  });

  console.log(`✅ User de test prêt :\n   email    : ${EMAIL}\n   password : ${PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
