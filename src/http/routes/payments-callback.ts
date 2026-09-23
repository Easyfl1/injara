import type { FastifyInstance } from "fastify";

export async function paymentsCallback(app: FastifyInstance): Promise<void> {
  app.get("/payments/callback", async (_req, reply) => {
    reply.type("text/html").send(`
      <!DOCTYPE html>
      <html>
      <head><title>Injara</title></head>
      <body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h2>Payment Processed</h2>
        <p>You can return to Telegram to check your order status.</p>
        <p>If you have any issues, please contact support.</p>
      </body>
      </html>
    `);
  });
}
