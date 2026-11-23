export type DownloadMode = "auto" | "video" | "audio";
export type MediaKind = "photo" | "video" | "audio" | "document";

export interface MediaMetadata {
  id?: string;
  title?: string;
  description?: string;
  uploader?: string;
  uploaderId?: string;
  /** URL pública do perfil/canal do autor quando disponível. */
  profileUrl?: string;
  duration?: number;
  webpageUrl?: string;
  thumbnail?: string;
  extractor?: string;
  /** Legenda HTML já formatada por um extrator específico. */
  captionHtml?: string;
}

export interface PreparedMediaItem {
  path: string;
  kind: MediaKind;
  filename: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
}

/**
 * Mídia pública que pode ser transmitida diretamente ao Telegram pelo grammY,
 * sem salvar em disco e sem passar pelo FFmpeg no caminho normal.
 */
export interface RemoteMediaItem {
  url: string;
  kind: "photo" | "video";
  filename?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  duration?: number;
  /** Tamanho estimado (bytes) da URL principal, quando a fonte permite calcular. */
  sizeBytes?: number;
  /** Alternativas da mesma mídia, da melhor compatível para a menor. */
  fallbackUrls?: string[];
}

export interface CachedMediaItem {
  kind: MediaKind;
  fileId: string;
  filename?: string;
}

/**
 * Trecho de um "artigo" (rich message do Telegram): HTML ou um grupo de
 * mídias que aparece naquela posição do texto. É o formato que o SmudgeLord
 * usa para tweets com quote: cada tweet com o próprio texto e as próprias
 * mídias, tudo em uma única mensagem com botão.
 */
export type MediaArticlePart = { html: string } | { media: RemoteMediaItem[] };

/** Artigo já enviado: HTML final e os file_id de cada mídia referenciada. */
export interface CachedArticle {
  html: string;
  media: Array<{ id: string; kind: "photo" | "video"; fileId: string }>;
}

export interface CachedMediaPayload {
  article?: CachedArticle;
  items: CachedMediaItem[];
  metadata: MediaMetadata;
  cachedAt: string;
}

export interface DownloadRequest {
  url: string;
  mode: DownloadMode;
  automatic: boolean;
  requesterId: number;
  chatId: number;
  replyToMessageId?: number;
  captionEnabled: boolean;
  errorMessagesEnabled: boolean;
  deleteSource: boolean;
  sourceMessageId?: number;
}

export interface DownloadedMedia {
  directory?: string;
  files: string[];
  remoteItems?: RemoteMediaItem[];
  /** Quando presente, o envio preferencial é uma única rich message. */
  article?: MediaArticlePart[];
  metadata: MediaMetadata;
}
