import { prisma } from "./client";

// Usage counts that more than one service enforces (see shared-types plans.ts).

/**
 * Bytes a business's knowledge takes up: documents (text, pending uploads),
 * passages and products, including their search vectors. pg_column_size of the
 * whole row is what Postgres stores, compressed.
 */
export async function knowledgeStorageBytes(businessId: string): Promise<number> {
  const [row] = await prisma.$queryRaw<{ bytes: bigint | null }[]>`
    SELECT
      COALESCE((SELECT SUM(pg_column_size(d.*)) FROM "KnowledgeDocument" d WHERE d."businessId" = ${businessId}), 0)
      + COALESCE((SELECT SUM(pg_column_size(c.*)) FROM "KnowledgeChunk" c WHERE c."businessId" = ${businessId}), 0)
      + COALESCE((SELECT SUM(pg_column_size(p.*)) FROM "Product" p WHERE p."businessId" = ${businessId}), 0)
      AS bytes
  `;
  return Number(row?.bytes ?? 0);
}

/** Team seats: members plus invitations still waiting to be accepted. */
export async function memberSeats(businessId: string): Promise<number> {
  const [members, invitations] = await Promise.all([
    prisma.membership.count({ where: { businessId } }),
    prisma.invitation.count({ where: { businessId, status: "pending", expiresAt: { gt: new Date() } } }),
  ]);
  return members + invitations;
}
