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
  INSTAGRAM_SCRAPER_URL: optional,
  INSTAGRAM_COOKIE: optional,
  INSTAGRAM_COOKIES_B64: optional,
  INSTAGRAM_X_IG_APP_ID: z.string().min(1).default("936619743392459"),
  FXTWITTER_API_URL: z.string().url().default("https://api.fxtwitter.com"),
  FFMPEG_BINARY: z.string().default("ffmpeg"),
  FFPROBE_BINARY: z.string().default("ffprobe"),
  YTDLP_COOKIES_B64: optional,
  YOUTUBE_COOKIES_B64: optional,
  YTDLP_PROXY: optional,
  MEDIA_ALLOWED_DOMAINS: z.string().default(""),
  ALLOW_GENERIC_URLS: bool.default(false),
  MAX_LINKS_PER_MESSAGE: z.coerce.number().int().min(1).max(10).default(3),
  // Instagram e X/Twitter aceitam até 20 mídias por publicação; o envio é
  // fatiado em álbuns de 10 (limite do Telegram). Com quote no X, o tweet
  // citado tem o próprio limite de MAX_MEDIA_ITEMS.
  MAX_MEDIA_ITEMS: z.coerce.number().int().min(1).max(20).default(20),
  MAX_UPLOAD_MB: z.coerce.number().min(1).max(2000).default(49),
  MAX_AUTO_DURATION_SECONDS: z.coerce.number().int().min(1).default(180),
  MAX_FORCE_DURATION_SECONDS: z.coerce.number().int().min(1).default(1800),
  DOWNLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  DOWNLOAD_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(0),
  DOWNLOAD_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(3600).default(180),
  // Desempenho de vídeo: por padrão, vídeos já compatíveis com o Telegram são
  // apenas remuxados (stream copy), sem recodificar. Ligue VIDEO_ALWAYS_TRANSCODE
  // apenas se quiser o comportamento antigo (recodificar tudo).
  VIDEO_ALWAYS_TRANSCODE: bool.default(false),
  VIDEO_MAX_PASSTHROUGH_FPS: z.coerce.number().min(1).max(120).default(61),
  // Borda máxima (px) que passa sem recodificar. 1920 deixa Reels/TikToks
  // verticais 1080x1920 e vídeos 1080p passarem com qualidade original.
  VIDEO_MAX_PASSTHROUGH_EDGE: z.coerce.number().int().min(720).max(4096).default(1920),
  // Bitrate máximo (bps) quando a recodificação é inevitável (vídeo > limite de
  // upload). Elevado de 2M para 6M para não pixelar quando precisa recodificar.
  VIDEO_TRANSCODE_MAX_BITRATE: z.coerce.number().int().min(500_000).max(20_000_000).default(6_000_000),
  VIDEO_TRANSCODE_PRESET: z.enum([
    "ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow",
  ]).default("veryfast"),
  // Concorrência de preparação de mídia (ffmpeg/sharp). Aumente em máquinas com
  // mais núcleos para preparar álbuns em paralelo.
  MEDIA_PREP_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(4),
  // Downloads simultâneos de mídias remotas (álbuns do Instagram etc.).
  REMOTE_DOWNLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(6),
  // Caminho rápido: envia vídeos/fotos remotos já prontos (Twitter/X e a maioria
  // dos CDNs) direto ao Telegram, sem baixar em disco nem passar pelo FFmpeg.
  // É o que torna o envio quase instantâneo, como no SmudgeLord.
  REMOTE_FAST_PATH: bool.default(true),
  // Hosts de CDN extras (separados por vírgula) que o Telegram pode baixar
  // direto, além dos padrões (Twitter/Instagram/TikTok/Reddit). Ex:
  // "meucdn.com,outrocdn.net". Deixe vazio para usar só os padrões.
  TELEGRAM_DIRECT_CDN_HOSTS: z.string().default(""),
  // Extrator dedicado de TikTok (via API tikwm) em vez do yt-dlp. Muito mais
  // rápido: devolve a URL direta do MP4 sem marca d'água, igual ao Twitter.
  TIKTOK_DIRECT_ENABLED: bool.default(true),
  TIKTOK_API_URL: z.string().default("https://www.tikwm.com/api/"),
  // Pede ao tikwm a versão HD (qualidade original) e a usa como principal; a
  // versão padrão fica como alternativa. Desligue para priorizar velocidade.
  TIKTOK_HD: bool.default(true),
  // Timeout curto por tentativa nos fallbacks do Instagram, para falhar rápido
  // e ir para a próxima estratégia em vez de travar.
  INSTAGRAM_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(4000),
  // Se a fonte atual do Instagram não respondeu nesse tempo, a próxima é
  // disparada em paralelo (sem cancelar a anterior).
  INSTAGRAM_HEDGE_DELAY_MS: z.coerce.number().int().min(0).max(10000).default(900),
  // Timeout por consulta ao X/Twitter (FxTwitter e GraphQL rodam em paralelo).
  TWITTER_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),
  // Depois que a primeira fonte do X responde, quanto esperar pela segunda
  // para complementar variantes de vídeo/texto antes de enviar.
  TWITTER_MERGE_GRACE_MS: z.coerce.number().int().min(0).max(10000).default(1200),
  MEDIA_CACHE_TTL_SECONDS: z.coerce.number().int().min(60).default(604800),
  MEDIA_PROGRESS_MESSAGES: bool.default(false),
  MEDIA_INCLUDE_SOURCE_LINK: bool.default(true),
  MEDIA_SOURCE_BUTTON: bool.default(true),
  // Tweets com quote são enviados como uma única rich message (texto e mídias
  // de cada tweet, com botão), igual ao SmudgeLord. Desligue para usar álbum.
  MEDIA_ARTICLES: bool.default(true),
  DELETE_TEMP_FILES: bool.default(true),
  // ---- WhatsApp via Evolution API -------------------------------------------
  // O canal liga sozinho quando URL, chave e instância estão preenchidas.
  WHATSAPP_ENABLED: bool.default(true),
  EVOLUTION_API_URL: optional,
  EVOLUTION_API_KEY: optional,
  EVOLUTION_INSTANCE: optional,
  // Endereço público deste servidor; usado para registrar o webhook na Evolution.
  SERVER_URL: optional,
  WHATSAPP_WEBHOOK_SECRET: optional,
  // Proteções contra banimento do número.
  WHATSAPP_MAX_MEDIA: z.coerce.number().int().min(1).max(10).default(4),
  WHATSAPP_USER_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(20),
  WHATSAPP_CHAT_HOURLY_LIMIT: z.coerce.number().int().min(1).max(1000).default(15),
  WHATSAPP_GLOBAL_HOURLY_LIMIT: z.coerce.number().int().min(1).max(10000).default(120),
  WHATSAPP_MIN_DELAY_MS: z.coerce.number().int().min(0).max(60000).default(1500),
  WHATSAPP_MAX_DELAY_MS: z.coerce.number().int().min(0).max(120000).default(4000),
  WHATSAPP_MAX_MESSAGE_AGE_SECONDS: z.coerce.number().int().min(10).max(86400).default(180),
  WHATSAPP_MAX_QUEUE: z.coerce.number().int().min(1).max(1000).default(20),
  WHATSAPP_GROUPS: bool.default(true),
  // /fig: figurinha avulsa a partir de foto, GIF ou vídeo curto.
  WHATSAPP_STICKERS: bool.default(true),
  // Autor gravado na figurinha (aparece ao tocar nela). Vazio = sem autor.
  WHATSAPP_STICKER_AUTHOR: z.string().default("bot de figurinhas"),
  // Serviço auxiliar (whatsgoapi) usado só para figurinhas com áudio (/audio).
  // Veja deploy/whatsgoapi. Sem estas variáveis o /audio envia sem som.
  SOUND_STICKER_API_URL: optional,
  SOUND_STICKER_API_KEY: optional,
  SOUND_STICKER_INSTANCE: z.string().min(1).default("figurinhas"),
  WHATSAPP_STICKER_MAX_SECONDS: z.coerce.number().int().min(1).max(10).default(8),
  WHATSAPP_STICKER_MAX_INPUT_MB: z.coerce.number().min(1).max(100).default(20),
  // Lista opcional de chats atendidos (números ou JIDs, separados por vírgula).
  WHATSAPP_ALLOWED_CHATS: z.string().default(""),
  // Vídeo acima deste tamanho é comprimido para caber e continuar chegando
  // como vídeo (nunca como arquivo). Demais arquivos acima do limite são omitidos.
  WHATSAPP_MAX_VIDEO_MB: z.coerce.number().min(1).max(2000).default(16),
  WHATSAPP_MAX_FILE_MB: z.coerce.number().min(1).max(2000).default(49),
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
  WHATSAPP_MAX_VIDEO_BYTES: Math.floor(parsed.data.WHATSAPP_MAX_VIDEO_MB * 1024 * 1024),
  WHATSAPP_MAX_FILE_BYTES: Math.floor(parsed.data.WHATSAPP_MAX_FILE_MB * 1024 * 1024),
  WHATSAPP_STICKER_MAX_INPUT_BYTES: Math.floor(parsed.data.WHATSAPP_STICKER_MAX_INPUT_MB * 1024 * 1024),
  WHATSAPP_ALLOWED_CHAT_LIST: parsed.data.WHATSAPP_ALLOWED_CHATS.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean),
  EXTRA_ALLOWED_DOMAINS: parsed.data.MEDIA_ALLOWED_DOMAINS.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean),
} as const;