import { z } from "zod";

const bool = z.union([z.boolean(), z.string()]).transform((v) => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase()));
const optional = z.string().optional().transform((v) => v?.trim() || undefined);

const schema = z.object({
  TELEGRAM_TOKEN: z.string().min(20),
  BOT_DISPLAY_NAME: z.string().min(1).default("Esqueletops • Nova"),
  OWNER_IDS: z.string().min(1),
  LOG_CHANNEL_ID: optional,
  BOT_API_URL: z.string().url().default("https://api.telegram.org"),
  AUTO_CONFIGURE_BOT: bool.default(true),
  RUN_MODE: z.enum(["polling", "webhook"]).default("polling"),
  POLLING_LOCK_ENABLED: bool.default(true),
  POLLING_LOCK_TTL_SECONDS: z.coerce.number().int().min(15).max(300).default(45),
  POLLING_LOCK_RETRY_SECONDS: z.coerce.number().int().min(1).max(60).default(5),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEBHOOK_URL: optional,
  WEBHOOK_SECRET: optional,
  DATABASE_URL: z.string().min(10),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.string().min(8),
  REDIS_REQUIRED: bool.default(true),
  REDIS_PREFIX: z.string().min(1).default("esqueletops:nova"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  LOG_HEARTBEAT_SECONDS: z.coerce.number().int().min(0).max(86400).default(300),
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  TZ: z.string().default("America/Sao_Paulo"),
  YTDLP_BINARY: z.string().default("yt-dlp"),
  GALLERYDL_BINARY: z.string().default("gallery-dl"),
  GALLERYDL_ENABLED: bool.default(true),
  INSTAGRAM_EMBED_ENABLED: bool.default(true),
  FXTWITTER_API_URL: z.string().url().default("https://api.fxtwitter.com"),
  FFMPEG_BINARY: z.string().default("ffmpeg"),
  FFPROBE_BINARY: z.string().default("ffprobe"),
  YTDLP_COOKIES_B64: optional,
  YTDLP_PROXY: optional,
  MEDIA_ALLOWED_DOMAINS: z.string().default(""),
  ALLOW_GENERIC_URLS: bool.default(false),
  MAX_LINKS_PER_MESSAGE: z.coerce.number().int().min(1).max(10).default(3),
  MAX_MEDIA_ITEMS: z.coerce.number().int().min(1).max(20).default(10),
  MAX_UPLOAD_MB: z.coerce.number().min(1).max(2000).default(49),
  MAX_AUTO_DURATION_SECONDS: z.coerce.number().int().min(1).default(180),
  MAX_FORCE_DURATION_SECONDS: z.coerce.number().int().min(1).default(1800),
  DOWNLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  DOWNLOAD_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(0),
  DOWNLOAD_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(3600).default(180),
  MEDIA_CACHE_TTL_SECONDS: z.coerce.number().int().min(60).default(604800),
  MEDIA_PROGRESS_MESSAGES: bool.default(false),
  MEDIA_INCLUDE_SOURCE_LINK: bool.default(true),
  MEDIA_SOURCE_BUTTON: bool.default(true),
  DELETE_TEMP_FILES: bool.default(true),
  TRANSLATE_PROVIDER: z.enum(["google", "libretranslate"]).default("google"),
  LIBRETRANSLATE_URL: optional,
  LIBRETRANSLATE_API_KEY: optional,
  WEATHER_DEFAULT_LANGUAGE: z.string().default("pt"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error("Variáveis de ambiente inválidas:\n" + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
}
const owners = parsed.data.OWNER_IDS.split(",").map((v) => Number(v.trim())).filter((v) => Number.isSafeInteger(v) && v > 0);
if (!owners.length) throw new Error("OWNER_IDS precisa conter pelo menos um ID válido.");
const logChannel = parsed.data.LOG_CHANNEL_ID ? Number(parsed.data.LOG_CHANNEL_ID) : undefined;
if (logChannel !== undefined && !Number.isSafeInteger(logChannel)) throw new Error("LOG_CHANNEL_ID inválido.");
if (parsed.data.RUN_MODE === "webhook" && !parsed.data.WEBHOOK_URL) throw new Error("WEBHOOK_URL é obrigatório em webhook.");

export const env = {
  ...parsed.data,
  OWNER_IDS: owners,
  LOG_CHANNEL_ID: logChannel,
  MAX_UPLOAD_BYTES: Math.floor(parsed.data.MAX_UPLOAD_MB * 1024 * 1024),
  EXTRA_ALLOWED_DOMAINS: parsed.data.MEDIA_ALLOWED_DOMAINS.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean),
} as const;
