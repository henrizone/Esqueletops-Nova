import type { Context } from "grammy";
import type { Locale } from "../database/repositories.js";
import type { TranslationKey, TranslationParams } from "../i18n/index.js";
export interface BotContext extends Context { locale:Locale; t:(key:TranslationKey,params?:TranslationParams)=>string; }
