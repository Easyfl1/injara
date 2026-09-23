import Fastify from "fastify";
import { prisma } from "../db/prisma.js";
import { getRedis } from "../redis/client.js";

export async function buildServer() {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "production",
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      const redis = getRedis();
      const pong = await redis.ping();
      if (pong !== "PONG") throw new Error("Redis not ready");
      return { status: "ready" };
    } catch (err) {
      reply.code(503);
      return { status: "not ready", error: (err as Error).message };
    }
  });

  return app;
}
