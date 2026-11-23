import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
  connectionName: "esqueletops-nova",
  retryStrategy: (times: number) => Math.min(times * 500, 10_000),
});
redis.on("error", (error: Error) => logger.error({ error }, "Erro no Redis"));
const key = (raw: string) => `${env.REDIS_PREFIX}:${raw}`;

export async function connectRedis() {
  try { if (redis.status === "wait") await redis.connect(); await redis.ping(); logger.info("Redis conectado"); }
  catch (error) { if (env.REDIS_REQUIRED) throw error; logger.warn({ error }, "Redis indisponível"); }
}
export async function closeRedis() { try { await redis.quit(); } catch { redis.disconnect(); } }
export async function cacheGetJson<T>(raw: string): Promise<T | null> { try { const value = await redis.get(key(raw)); return value ? JSON.parse(value) as T : null; } catch { return null; } }
export async function cacheSetJson(raw: string, value: unknown, ttl: number) { await redis.set(key(raw), JSON.stringify(value), "EX", ttl); }
export async function cacheDelete(raw: string) { await redis.del(key(raw)); }
export async function acquireLock(raw: string, ttl: number): Promise<string | null> { const token = crypto.randomUUID(); return await redis.set(key(`lock:${raw}`), token, "EX", ttl, "NX") === "OK" ? token : null; }
export async function releaseLock(raw: string, token: string) { await redis.eval('if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end', 1, key(`lock:${raw}`), token); }
export async function renewLock(raw: string, token: string, ttl: number): Promise<boolean> {
  const result = await redis.eval('if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end', 1, key(`lock:${raw}`), token, String(ttl));
  return Number(result) === 1;
}
/** Marca uma chave como vista. Devolve false se ela já existia (evento repetido). */
export async function claimOnce(raw: string, ttl: number): Promise<boolean> {
  return await redis.set(key(`once:${raw}`), "1", "EX", ttl, "NX") === "OK";
}
/** Contador em janela fixa: incrementa e devolve o total dentro da janela de `ttl` segundos. */
export async function incrementWindow(raw: string, ttl: number): Promise<number> {
  const k = key(`window:${raw}`);
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, ttl);
  return count;
}
export async function consumeCooldown(raw: string, ttl: number): Promise<number> { if (ttl <= 0) return 0; const k = key(`cooldown:${raw}`); if (await redis.set(k, "1", "EX", ttl, "NX") === "OK") return 0; return Math.max(await redis.ttl(k), 1); }
