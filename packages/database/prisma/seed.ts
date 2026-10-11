import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../src/index";

// Local dev seed. Businesses are not self-serve yet, so this is where they come
// from. Creates two businesses and three users, including one user who belongs
// to both businesses with a different role in each — the case the whole
// membership model exists for.
const PASSWORD = "password123";

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const acme = await prisma.business.upsert({
    where: { slug: "acme" },
    update: {},
    create: { name: "Acme Corp", slug: "acme" },
  });

  const globex = await prisma.business.upsert({
    where: { slug: "globex" },
    update: {},
    create: { name: "Globex", slug: "globex" },
  });

  const owner = await prisma.user.upsert({
    where: { email: "owner@acme.test" },
    update: {},
    create: { email: "owner@acme.test", name: "Olivia Owner", passwordHash },
  });

  const member = await prisma.user.upsert({
    where: { email: "member@acme.test" },
    update: {},
    create: { email: "member@acme.test", name: "Marco Member", passwordHash },
  });

  // Belongs to both businesses.
  const shared = await prisma.user.upsert({
    where: { email: "shared@example.test" },
    update: {},
    create: { email: "shared@example.test", name: "Sam Shared", passwordHash },
  });

  const memberships: Array<{ userId: string; businessId: string; role: string }> = [
    { userId: owner.id, businessId: acme.id, role: "owner" },
    { userId: member.id, businessId: acme.id, role: "member" },
    { userId: shared.id, businessId: acme.id, role: "admin" },
    { userId: shared.id, businessId: globex.id, role: "owner" },
  ];

  for (const m of memberships) {
    await prisma.membership.upsert({
      where: { userId_businessId: { userId: m.userId, businessId: m.businessId } },
      update: { role: m.role },
      create: m,
    });
  }

  // One pending invitation to demonstrate the accept flow.
  await prisma.invitation.upsert({
    where: { businessId_email: { businessId: globex.id, email: "member@acme.test" } },
    update: {},
    create: {
      businessId: globex.id,
      email: "member@acme.test",
      role: "member",
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      invitedByUserId: shared.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  console.log("Seeded businesses: acme, globex");
  console.log(`Users (password: ${PASSWORD}):`);
  console.log("  owner@acme.test     -> Acme (owner)");
  console.log("  member@acme.test    -> Acme (member), pending invite to Globex");
  console.log("  shared@example.test -> Acme (admin) + Globex (owner)");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
