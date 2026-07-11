import type { BotContext } from "../types/context.js";
import { env } from "../config/env.js";
import { cacheGetJson, cacheSetJson } from "../cache/redis.js";
export const isOwner=(id:number|undefined)=>id!==undefined&&env.OWNER_IDS.includes(id);
export async function isGroupAdmin(ctx:BotContext,userId=ctx.from?.id){if(!ctx.chat||!userId)return false;if(isOwner(userId))return true;if(!["group","supergroup"].includes(ctx.chat.type))return false;const k=`admin:${ctx.chat.id}:${userId}`;const c=await cacheGetJson<boolean>(k);if(c!==null)return c;try{const m=await ctx.api.getChatMember(ctx.chat.id,userId);const ok=m.status==="creator"||m.status==="administrator";await cacheSetJson(k,ok,60);return ok;}catch{return false;}}
export async function requireGroupAdmin(ctx:BotContext){if(!ctx.chat||!["group","supergroup"].includes(ctx.chat.type)){await ctx.reply(ctx.t("onlyGroups"),{parse_mode:"HTML"});return false;}if(!await isGroupAdmin(ctx)){await ctx.reply(ctx.t("adminOnly"),{parse_mode:"HTML"});return false;}return true;}
