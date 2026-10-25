import { PrismaClient } from "@prisma/client";

// One client per process, shared across the service via import.
export const prisma = new PrismaClient();
