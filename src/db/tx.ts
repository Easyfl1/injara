import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

export type PrismaTransactionClient = Prisma.TransactionClient;

export async function inTransaction<T>(
  fn: (tx: PrismaTransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => fn(tx), {
    maxWait: 10000,
    timeout: 30000,
  });
}

export { prisma };
