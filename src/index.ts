import { run, type RunnerHandle } from "@grammyjs/runner";
import Fastify from "fastify";
import { GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { bot, configureBotProfile } from "./bot.js";
import {
  acquireLock,
  closeRedis,
  connectRedis,
  redis,
  releaseLock,
  renewLock,
} from "./cache/redis.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { closeDatabase, connectDatabase, db } from "./database/index.js";

const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
let ready = false;
let runner: RunnerHandle | undefined;
let heartbeat: NodeJS.Timeout | undefined;
let pollingLockRenewal: NodeJS.Timeout | undefined;
let pollingLockToken: string | undefined;
let pollingLockKey: string | undefined;
let shuttingDown = false;

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function isPollingConflict(error: unknown) {
  return error instanceof GrammyError
    && error.error_code === 409
    && /other getUpdates request/i.test(error.description);
}

app.get("/health", async () => ({
  ok: true,
  service: "esqueletops-nova",
  ready,
  mode: env.RUN_MODE,
  polling: runner?.isRunning() ?? false,
  uptimeSeconds: Math.floor(process.uptime()),
}));

app.get("/ready", async (_request, reply) => {
  try {
    await db.query("SELECT 1");
    await redis.ping();
    if (!ready) throw new Error("not ready");
    return { ok: true };
  } catch (error) {
    logger.warn({ err: error }, "Readiness check falhou");
    return reply.code(503).send({ ok: false });
  }
});

if (env.RUN_MODE === "webhook") {
  app.post<{ Body: Update }>("/telegram", async (request, reply) => {
    const secret = request.headers["x-telegram-bot-api-secret-token"];
    if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
      return reply.code(401).send({ ok: false });
    }
    await bot.handleUpdate(request.body);
    return { ok: true };
  });
}

async function clearPollingLock() {
  if (pollingLockRenewal) clearInterval(pollingLockRenewal);
  pollingLockRenewal = undefined;
  if (pollingLockToken && pollingLockKey) {
    await releaseLock(pollingLockKey, pollingLockToken).catch(() => undefined);
  }
  pollingLockToken = undefined;
  pollingLockKey = undefined;
}

async function waitForPollingLock(): Promise<{ key: string; token: string } | undefined> {
  if (!env.POLLING_LOCK_ENABLED) return undefined;
  const key = `telegram-polling:${bot.botInfo.id}`;
  while (!shuttingDown) {
    try {
      const token = await acquireLock(key, env.POLLING_LOCK_TTL_SECONDS);
      if (token) return { key, token };
    } catch (error) {
      if (env.REDIS_REQUIRED) throw error;
      logger.warn({ error }, "Redis indisponível; polling seguirá sem trava distribuída");
      return undefined;
    }
    logger.warn({ retrySeconds: env.POLLING_LOCK_RETRY_SECONDS }, "Outra instância ainda controla o polling; aguardando liberação");
    await sleep(env.POLLING_LOCK_RETRY_SECONDS * 1000);
  }
  return undefined;
}

function startPollingLockRenewal(handle: RunnerHandle, key: string, token: string) {
  const intervalMs = Math.max(5_000, Math.floor(env.POLLING_LOCK_TTL_SECONDS * 1000 / 3));
  pollingLockRenewal = setInterval(() => {
    void renewLock(key, token, env.POLLING_LOCK_TTL_SECONDS)
      .then(async (renewed) => {
        if (renewed || shuttingDown || runner !== handle) return;
        logger.error("A trava distribuída do polling foi perdida; interrompendo esta instância");
        ready = false;
        await handle.stop().catch(() => undefined);
      })
      .catch(async (error) => {
        logger.error({ error }, "Falha ao renovar a trava distribuída do polling");
        if (env.REDIS_REQUIRED && !shuttingDown && runner === handle) {
          ready = false;
          await handle.stop().catch(() => undefined);
        }
      });
  }, intervalMs);
  pollingLockRenewal.unref();
}

async function startPolling() {
  const lock = await waitForPollingLock();
  if (shuttingDown) return;

  pollingLockKey = lock?.key;
  pollingLockToken = lock?.token;
  await bot.api.deleteWebhook({ drop_pending_updates: false });

  const handle = run(bot, {
    runner: {
      fetch: {
        allowed_updates: ["message", "callback_query", "inline_query", "my_chat_member"],
      },
      retryInterval: "exponential",
      maxRetryTime: 60_000,
    },
  });
  runner = handle;
  if (lock) startPollingLockRenewal(handle, lock.key, lock.token);
  ready = true;
  logger.info({ username: bot.botInfo.username }, "Bot iniciado por polling");

  const task = handle.task();
  if (!task) return;
  void task.then(
    () => monitorPollingStop(handle, undefined),
    (error) => monitorPollingStop(handle, error),
  );
}

async function monitorPollingStop(handle: RunnerHandle, error: unknown) {
  if (runner !== handle) return;
  runner = undefined;
  ready = false;
  await clearPollingLock();

  if (shuttingDown) return;
  if (isPollingConflict(error)) {
    logger.warn({ error }, "Conflito de getUpdates detectado; aguardando a instância anterior encerrar e tentando novamente");
  } else if (error) {
    logger.error({ error }, "Polling foi interrompido inesperadamente; tentando reiniciar");
  } else {
    logger.warn("Polling foi encerrado; tentando reiniciar");
  }

  await sleep(env.POLLING_LOCK_RETRY_SECONDS * 1000);
  if (!shuttingDown) {
    await startPolling().catch((restartError) => {
      logger.fatal({ error: restartError }, "Não foi possível reiniciar o polling");
      void shutdown("polling-restart-error").finally(() => process.exit(1));
    });
  }
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  if (heartbeat) clearInterval(heartbeat);

  logger.info({ signal }, "Encerrando aplicação");
  const activeRunner = runner;
  runner = undefined;
  await activeRunner?.stop().catch(() => undefined);
  await clearPollingLock();
  await app.close().catch(() => undefined);
  await closeRedis().catch(() => undefined);
  await closeDatabase().catch(() => undefined);
  logger.info("Aplicação encerrada");
}

async function main() {
  logger.info({
    node: process.version,
    mode: env.RUN_MODE,
    host: env.HOST,
    port: env.PORT,
  }, "Iniciando Esqueletops • Nova");

  logger.info("Conectando ao PostgreSQL");
  await connectDatabase();

  logger.info("Conectando ao Redis");
  await connectRedis();

  logger.info("Inicializando cliente do Telegram");
  await bot.init();
  await configureBotProfile();

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ host: env.HOST, port: env.PORT }, "Servidor de healthcheck iniciado");

  if (env.RUN_MODE === "webhook") {
    const webhookUrl = `${env.WEBHOOK_URL!.replace(/\/$/, "")}/telegram`;
    await bot.api.setWebhook(webhookUrl, {
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query", "inline_query", "my_chat_member"],
    });
    ready = true;
    logger.info({ webhookUrl }, "Bot iniciado por webhook");
  } else {
    await startPolling();
  }

  logger.info({
    username: bot.botInfo.username,
    health: `http://${env.HOST}:${env.PORT}/health`,
    readiness: `http://${env.HOST}:${env.PORT}/ready`,
  }, "Aplicação pronta");

  if (env.LOG_HEARTBEAT_SECONDS > 0) {
    heartbeat = setInterval(() => {
      logger.info({
        ready,
        polling: runner?.isRunning() ?? false,
        uptimeSeconds: Math.floor(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      }, "Aplicação ativa");
    }, env.LOG_HEARTBEAT_SECONDS * 1000);
    heartbeat.unref();
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

process.on("warning", (warning) => logger.warn({ err: warning }, "Aviso do processo Node.js"));
process.on("unhandledRejection", (error) => logger.error({ err: error }, "Promise rejeitada sem tratamento"));
process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "Exceção não tratada");
  void shutdown("uncaughtException").finally(() => process.exit(1));
});

main().catch((error) => {
  logger.fatal({ err: error }, "Falha ao iniciar");
  void shutdown("startup-error").finally(() => process.exit(1));
});
