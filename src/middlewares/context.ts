import type { MiddlewareFn } from "grammy";
import { getLocale, upsertChat, upsertUser } from "../database/repositories.js";
import { translate } from "../i18n/index.js";
import type { BotContext } from "../types/context.js";
import { logger } from "../config/logger.js";
export const contextMiddleware:MiddlewareFn<BotContext>=async(ctx,next)=>{
 try{if(ctx.from)await upsertUser(ctx.from);if(ctx.chat)await upsertChat(ctx.chat);}catch(error){logger.error({error},"Falha ao salvar contexto");}
 const fallback=ctx.from?.language_code?.toLowerCase().startsWith("pt")?"pt_BR":"en_US";try{ctx.locale=ctx.from?await getLocale(ctx.chat?.id,ctx.from.id):fallback;}catch{ctx.locale=fallback;}
 ctx.t=(key,params)=>translate(ctx.locale,key,params);await next();
};
