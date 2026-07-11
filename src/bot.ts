import { autoRetry } from "@grammyjs/auto-retry";
import { Bot } from "grammy";
import { env } from "./config/env.js";
import { afkMiddleware, registerAfkModule } from "./modules/afk.js";
import { registerConfigModule } from "./modules/config.js";
import { registerInlineModule } from "./modules/inline.js";
import { registerMediaModule } from "./modules/media.js";
import { registerMenuModule } from "./modules/menu.js";
import { registerMiscModule } from "./modules/misc.js";
import { registerOwnerModule } from "./modules/owner.js";
import { registerStickerModule } from "./modules/stickers.js";
import { contextMiddleware } from "./middlewares/context.js";
import { disabledCommandsMiddleware } from "./middlewares/disabled.js";
import { installErrorHandler } from "./middlewares/error-handler.js";
import type { BotContext } from "./types/context.js";

export const bot = new Bot<BotContext>(env.TELEGRAM_TOKEN, { client: { apiRoot: env.BOT_API_URL } });
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

bot.use(contextMiddleware);
bot.use(disabledCommandsMiddleware);
bot.use(afkMiddleware);
registerMenuModule(bot);
registerConfigModule(bot);
registerAfkModule(bot);
registerStickerModule(bot);
registerMiscModule(bot);
registerOwnerModule(bot);
registerInlineModule(bot);
registerMediaModule(bot);
installErrorHandler(bot);

export async function configureBotProfile() {
  if (!env.AUTO_CONFIGURE_BOT) return;
  await Promise.allSettled([
    bot.api.setMyName(env.BOT_DISPLAY_NAME),
    bot.api.setMyDescription("Bot multifunções: downloads automáticos, figurinhas, AFK, tradução, clima e ferramentas para grupos."),
    bot.api.setMyShortDescription("Downloads, figurinhas e utilidades para Telegram."),
    bot.api.setMyCommands([
      { command: "start", description: "Abrir o menu" },
      { command: "help", description: "Ver todos os comandos" },
      { command: "dl", description: "Baixar mídia de um link" },
      { command: "ytdl", description: "Baixar vídeo ou áudio do YouTube" },
      { command: "kang", description: "Adicionar mídia a um pacote de figurinhas" },
      { command: "newpack", description: "Criar um pacote de figurinhas" },
      { command: "mypacks", description: "Listar seus pacotes" },
      { command: "afk", description: "Ativar o modo AFK" },
      { command: "weather", description: "Consultar o clima" },
      { command: "tr", description: "Traduzir um texto" },
      { command: "config", description: "Configurar o bot no grupo" },
      { command: "privacy", description: "Ver a política de privacidade" },
    ]),
  ]);
}
