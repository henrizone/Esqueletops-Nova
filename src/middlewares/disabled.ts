import type { MiddlewareFn } from "grammy";
import { isCommandDisabled } from "../database/repositories.js";
import type { BotContext } from "../types/context.js";
import { isDisableable, normalizeCommand } from "../utils/commands.js";
export const disabledCommandsMiddleware:MiddlewareFn<BotContext>=async(ctx,next)=>{if(!ctx.chat||!["group","supergroup"].includes(ctx.chat.type))return next();const text=ctx.message?.text??ctx.message?.caption;if(!text?.startsWith("/"))return next();const command=normalizeCommand(text.split(/\s+/,1)[0]??"");if(!isDisableable(command))return next();if(await isCommandDisabled(ctx.chat.id,command)){await ctx.reply(ctx.t("commandDisabled",{command}),{parse_mode:"HTML"});return;}await next();};
