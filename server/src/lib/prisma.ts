import "dotenv/config";
import dns from "node:dns";
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prefer IPv4 first — some flaky resolvers return AAAA records that then fail to
// connect. This makes name resolution more reliable on home/ISP networks.
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  // older Node versions may not support this; safe to ignore
}

const connectionString = process.env.DATABASE_URL!;

const adapter = new PrismaPg({
  connectionString,
  // Give a cold Neon compute / slow DNS a bit more time before giving up.
  connectionTimeoutMillis: 15000,
});

const basePrisma = new PrismaClient({ adapter });

// On flaky networks the Neon hostname intermittently fails to resolve/connect,
// surfacing as Prisma P1001 (DatabaseNotReachable). These errors mean the query
// never reached the database, so it is safe to transparently retry them.
const TRANSIENT_PRISMA_CODES = new Set(["P1001", "P1002", "P1008", "P1017"]);
const TRANSIENT_MESSAGE =
  /DatabaseNotReachable|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|Closed|terminating connection/i;

function isTransient(error: any): boolean {
  return (
    TRANSIENT_PRISMA_CODES.has(error?.code) ||
    TRANSIENT_MESSAGE.test(String(error?.message ?? "")) ||
    TRANSIENT_MESSAGE.test(String(error?.cause?.message ?? ""))
  );
}

export const prisma = basePrisma.$extends({
  query: {
    async $allOperations({ model, operation, args, query }) {
      const maxAttempts = 5;
      let lastError: unknown;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await query(args);
        } catch (error) {
          lastError = error;

          if (!isTransient(error) || attempt === maxAttempts) {
            throw error;
          }

          const delayMs = 400 * attempt; // 400, 800, 1200, 1600 ms
          const firstLine = String((error as any)?.message ?? "").split("\n")[0];
          console.warn(
            `[db] transient error on ${model ?? "raw"}.${operation} ` +
              `(attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms — ${firstLine}`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      throw lastError;
    },
  },
});
