import type { Chat, User } from "grammy/types";
import { db } from "./index.js";
export type Locale = "pt_BR" | "en_US";
export type StickerFormat = "static" | "animated" | "video";
export interface ChatSettings { telegramId:number; type:string; title:string|null; username:string|null; locale:Locale; mediaAuto:boolean; mediaCaption:boolean; mediaErrors:boolean; deleteSource:boolean; }
export interface AfkStatus { userId:number; username:string|null; firstName:string; reason:string; since:Date; }
export interface StickerPackRecord { id:number; userId:number; packName:string; title:string; format:StickerFormat; isDefault:boolean; }
const localeFrom = (language?:string):Locale => language?.toLowerCase().startsWith("pt") ? "pt_BR" : "en_US";

export async function upsertUser(user:User) {
  await db.query(`INSERT INTO users(telegram_id,username,first_name,last_name,language_code,locale,is_bot,updated_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,
  first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,language_code=EXCLUDED.language_code,is_bot=EXCLUDED.is_bot,updated_at=NOW()`,
  [user.id,user.username??null,user.first_name,user.last_name??null,user.language_code??null,localeFrom(user.language_code),user.is_bot]);
}
export async function upsertChat(chat:Chat) {
  const isPrivate=chat.type==="private"; const title="title" in chat?chat.title:isPrivate?chat.first_name:null; const username="username" in chat?chat.username??null:null;
  await db.query(`INSERT INTO chats(telegram_id,type,title,username,updated_at) VALUES($1,$2,$3,$4,NOW())
  ON CONFLICT(telegram_id) DO UPDATE SET type=EXCLUDED.type,title=EXCLUDED.title,username=EXCLUDED.username,updated_at=NOW()`,[chat.id,chat.type,title??null,username]);
}
export async function getLocale(chatId:number|undefined,userId:number):Promise<Locale>{
  if(chatId!==undefined){const c=await db.query<{locale:Locale}>("SELECT locale FROM chats WHERE telegram_id=$1 AND type IN ('group','supergroup')",[chatId]);if(c.rows[0]?.locale)return c.rows[0].locale;}
  return (await db.query<{locale:Locale}>("SELECT locale FROM users WHERE telegram_id=$1",[userId])).rows[0]?.locale??"pt_BR";
}
export async function setLocale(target:"user"|"chat",id:number,locale:Locale){await db.query(`UPDATE ${target==="user"?"users":"chats"} SET locale=$1,updated_at=NOW() WHERE telegram_id=$2`,[locale,id]);}
export async function getChatSettings(chatId:number):Promise<ChatSettings>{
  const r=await db.query<any>("SELECT telegram_id,type,title,username,locale,media_auto,media_caption,media_errors,delete_source FROM chats WHERE telegram_id=$1",[chatId]);const x=r.rows[0];
  if(!x)return{telegramId:chatId,type:"unknown",title:null,username:null,locale:"pt_BR",mediaAuto:true,mediaCaption:true,mediaErrors:true,deleteSource:false};
  return{telegramId:x.telegram_id,type:x.type,title:x.title,username:x.username,locale:x.locale,mediaAuto:x.media_auto,mediaCaption:x.media_caption,mediaErrors:x.media_errors,deleteSource:x.delete_source};
}
export type ChatBooleanSetting="media_auto"|"media_caption"|"media_errors"|"delete_source";
export async function toggleChatSetting(chatId:number,setting:ChatBooleanSetting):Promise<boolean>{
  if(!["media_auto","media_caption","media_errors","delete_source"].includes(setting))throw new Error("Configuração inválida");
  return Boolean((await db.query<any>(`UPDATE chats SET ${setting}=NOT ${setting},updated_at=NOW() WHERE telegram_id=$1 RETURNING ${setting}`,[chatId])).rows[0]?.[setting]);
}
export async function setAfk(user:User,reason:string){await upsertUser(user);await db.query(`INSERT INTO afk_status(user_id,username,first_name,reason,since) VALUES($1,$2,$3,$4,NOW())
ON CONFLICT(user_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,reason=EXCLUDED.reason,since=NOW()`,[user.id,user.username??null,user.first_name,reason]);}
const afkMap=(x:any):AfkStatus=>({userId:x.user_id,username:x.username,firstName:x.first_name,reason:x.reason,since:x.since});
export async function clearAfk(userId:number):Promise<AfkStatus|null>{const x=(await db.query<any>("DELETE FROM afk_status WHERE user_id=$1 RETURNING user_id,username,first_name,reason,since",[userId])).rows[0];return x?afkMap(x):null;}
export async function getAfkByIds(ids:number[]):Promise<AfkStatus[]>{if(!ids.length)return[];return(await db.query<any>("SELECT user_id,username,first_name,reason,since FROM afk_status WHERE user_id=ANY($1::bigint[])",[ids])).rows.map(afkMap);}
export async function findUserIdByUsername(username:string):Promise<number|null>{return(await db.query<{telegram_id:number}>("SELECT telegram_id FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1",[username.replace(/^@/,"")])).rows[0]?.telegram_id??null;}
export async function disableCommand(chatId:number,command:string):Promise<boolean>{return((await db.query("INSERT INTO disabled_commands(chat_id,command) VALUES($1,$2) ON CONFLICT DO NOTHING",[chatId,command])).rowCount??0)>0;}
export async function enableCommand(chatId:number,command:string):Promise<boolean>{return((await db.query("DELETE FROM disabled_commands WHERE chat_id=$1 AND command=$2",[chatId,command])).rowCount??0)>0;}
export async function isCommandDisabled(chatId:number,command:string):Promise<boolean>{return Boolean((await db.query("SELECT 1 FROM disabled_commands WHERE chat_id=$1 AND command=$2",[chatId,command])).rowCount);}
export async function listDisabledCommands(chatId:number):Promise<string[]>{return(await db.query<{command:string}>("SELECT command FROM disabled_commands WHERE chat_id=$1 ORDER BY command",[chatId])).rows.map(x=>x.command);}
const packMap=(x:any):StickerPackRecord=>({id:x.id,userId:x.user_id,packName:x.pack_name,title:x.title,format:x.format,isDefault:x.is_default});
export async function listStickerPacks(userId:number,format?:StickerFormat):Promise<StickerPackRecord[]>{const p:any[]=[userId];if(format)p.push(format);return(await db.query<any>(`SELECT id,user_id,pack_name,title,format,is_default FROM sticker_packs WHERE user_id=$1 ${format?"AND format=$2":""} ORDER BY format,created_at`,p)).rows.map(packMap);}
export async function getDefaultStickerPack(userId:number,format:StickerFormat):Promise<StickerPackRecord|null>{const x=(await db.query<any>("SELECT id,user_id,pack_name,title,format,is_default FROM sticker_packs WHERE user_id=$1 AND format=$2 AND is_default=TRUE LIMIT 1",[userId,format])).rows[0];return x?packMap(x):null;}
export async function createStickerPack(input:{userId:number;packName:string;title:string;format:StickerFormat;makeDefault?:boolean}):Promise<StickerPackRecord>{
  const c=await db.connect();try{await c.query("BEGIN");if(input.makeDefault!==false)await c.query("UPDATE sticker_packs SET is_default=FALSE WHERE user_id=$1 AND format=$2",[input.userId,input.format]);
  const x=(await c.query<any>("INSERT INTO sticker_packs(user_id,pack_name,title,format,is_default) VALUES($1,$2,$3,$4,$5) RETURNING id,user_id,pack_name,title,format,is_default",[input.userId,input.packName,input.title,input.format,input.makeDefault!==false])).rows[0];await c.query("COMMIT");return packMap(x);}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}
export async function setDefaultStickerPack(userId:number,packId:number):Promise<boolean>{const c=await db.connect();try{await c.query("BEGIN");const format=(await c.query<{format:StickerFormat}>("SELECT format FROM sticker_packs WHERE id=$1 AND user_id=$2",[packId,userId])).rows[0]?.format;if(!format){await c.query("ROLLBACK");return false;}await c.query("UPDATE sticker_packs SET is_default=FALSE WHERE user_id=$1 AND format=$2",[userId,format]);await c.query("UPDATE sticker_packs SET is_default=TRUE,updated_at=NOW() WHERE id=$1",[packId]);await c.query("COMMIT");return true;}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}
export async function deleteStickerPackRecord(userId:number,packId:number):Promise<StickerPackRecord|null>{const x=(await db.query<any>("DELETE FROM sticker_packs WHERE id=$1 AND user_id=$2 RETURNING id,user_id,pack_name,title,format,is_default",[packId,userId])).rows[0];if(!x)return null;if(x.is_default)await db.query("UPDATE sticker_packs SET is_default=TRUE,updated_at=NOW() WHERE id=(SELECT id FROM sticker_packs WHERE user_id=$1 AND format=$2 ORDER BY created_at LIMIT 1)",[userId,x.format]);return packMap(x);}
export async function countAudience(){const[u,g]=await Promise.all([db.query<{count:number}>("SELECT COUNT(*)::bigint count FROM users WHERE blocked_at IS NULL AND is_bot=FALSE"),db.query<{count:number}>("SELECT COUNT(*)::bigint count FROM chats WHERE type IN('group','supergroup')")]);return{users:u.rows[0]?.count??0,groups:g.rows[0]?.count??0};}
export async function listAudience(target:"users"|"groups"|"all"):Promise<number[]>{let q=target==="users"?"SELECT telegram_id FROM users WHERE blocked_at IS NULL AND is_bot=FALSE":target==="groups"?"SELECT telegram_id FROM chats WHERE type IN('group','supergroup')":"SELECT telegram_id FROM users WHERE blocked_at IS NULL AND is_bot=FALSE UNION SELECT telegram_id FROM chats WHERE type IN('group','supergroup')";return(await db.query<{telegram_id:number}>(q)).rows.map(x=>x.telegram_id);}
export async function markUserBlocked(id:number){await db.query("UPDATE users SET blocked_at=NOW(),updated_at=NOW() WHERE telegram_id=$1",[id]);}
export async function writeAuditLog(i:{actorId?:number;chatId?:number;action:string;metadata?:Record<string,unknown>}){await db.query("INSERT INTO audit_logs(actor_id,chat_id,action,metadata) VALUES($1,$2,$3,$4::jsonb)",[i.actorId??null,i.chatId??null,i.action,JSON.stringify(i.metadata??{})]);}
