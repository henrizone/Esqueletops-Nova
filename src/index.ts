import { run, type RunnerHandle } from "@grammyjs/runner";
import Fastify from "fastify";
import type { Update } from "grammy/types";
import { bot, configureBotProfile } from "./bot.js";
import { connectRedis, closeRedis, redis } from "./cache/redis.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { closeDatabase, connectDatabase, db } from "./database/index.js";

const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
let ready = false;
let runner: RunnerHandle | undefined;
let shuttingDown = false;

app.get("/health", async () => ({ ok: true, service: "esqueletops-nova", ready }));
app.get("/ready", async (_request, reply) => {
  try { await db.query("SELECT 1"); await redis.ping(); if (!ready) throw new Error("not ready"); return { ok: true }; }
  catch { return reply.code(503).send({ ok: false }); }
});

if (env.RUN_MODE === "webhook") {
  app.post<{ Body: Update }>("/telegram", async (request, reply) => {
    const secret = request.headers["x-telegram-bot-api-secret-token"];
    if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) return reply.code(401).send({ ok: false });
    await bot.handleUpdate(request.body);
    return { ok: true };
  });
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true; ready = false;
  logger.info({ signal }, "Encerrando aplicação");
  await runner?.stop().catch(() => undefined);
  await bot.api.deleteWebhook().catch(() => undefined);
  await app.close().catch(() => undefined);
  await closeRedis().catch(() => undefined);
  await closeDatabase().catch(() => undefined);
}

async function main() {
  await connectDatabase();
  await connectRedis();
  await bot.init();
  await configureBotProfile();
  await app.listen({ host: "0.0.0.0", port: env.PORT });

  if (env.RUN_MODE === "webhook") {
    const webhookUrl = `${env.WEBHOOK_URL!.replace(/\/$/, "")}/telegram`;
    await bot.api.setWebhook(webhookUrl, { secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query", "inline_query", "my_chat_member"] });
    logger.info({ webhookUrl }, "Bot iniciado por webhook");
  } else {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    runner = run(bot, { runner: { fetch: { allowed_updates: ["message", "callback_query", "inline_query", "my_chat_member"] }, retryInterval: "exponential", maxRetryTime: 60_000 } });
    logger.info({ username: bot.botInfo.username }, "Bot iniciado por polling");
  }
  ready = true;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void shutdown(signal).finally(() => process.exit(0)); });
process.on("unhandledRejection", (error) => logger.fatal({ error }, "Promise rejeitada sem tratamento"));
process.on("uncaughtException", (error) => { logger.fatal({ error }, "Exceção não tratada"); void shutdown("uncaughtException").finally(() => process.exit(1)); });

main().catch((error) => { logger.fatal({ error }, "Falha ao iniciar"); void shutdown("startup-error").finally(() => process.exit(1)); });
