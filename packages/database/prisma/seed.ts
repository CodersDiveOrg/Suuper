import bcrypt from "bcryptjs";
import { prisma } from "../src/index";

// Local dev seed: one tenant + one owner user, fixed credentials so the
// frontend login screen has something real to authenticate against.
const TENANT_SLUG = "acme";
const SEED_EMAIL = "owner@acme.test";
const SEED_PASSWORD = "password123";

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: TENANT_SLUG },
    update: {},
    create: { name: "Acme Corp", slug: TENANT_SLUG },
  });

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: SEED_EMAIL } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: SEED_EMAIL,
      passwordHash,
      role: "owner",
    },
  });

  console.log(`Seeded tenant "${tenant.slug}" with user ${SEED_EMAIL} / ${SEED_PASSWORD}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
