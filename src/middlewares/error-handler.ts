import type { Bot } from "grammy";
import type { BotContext } from "../types/context.js";
import { logger } from "../config/logger.js";
import { env } from "../config/env.js";
import { errorCode, errorMessage } from "../utils/errors.js";
import { escapeHtml, truncate } from "../utils/html.js";
export function installErrorHandler(bot:Bot<BotContext>){bot.catch(async e=>{const code=errorCode("BOT");const ctx=e.ctx;logger.error({code,error:e.error,updateId:ctx.update.update_id,chatId:ctx.chat?.id,userId:ctx.from?.id},"Erro não tratado");if(env.LOG_CHANNEL_ID)await ctx.api.sendMessage(env.LOG_CHANNEL_ID,`<b>ERRO ${code}</b>\n<code>${escapeHtml(truncate(errorMessage(e.error),3000))}</code>\nChat: <code>${ctx.chat?.id??"-"}</code>`,{parse_mode:"HTML"}).catch(()=>undefined);if(ctx.chat)await ctx.reply(ctx.t("genericError",{code}),{parse_mode:"HTML"}).catch(()=>undefined);});}
