import { createHash } from "node:crypto";import { env } from "../../config/env.js";
const defaults=["instagram.com","tiktok.com","vm.tiktok.com","vt.tiktok.com","x.com","twitter.com","reddit.com","redd.it","v.redd.it","threads.net","bsky.app","pinterest.com","pin.it","substack.com","xiaohongshu.com","xhslink.com","youtube.com","youtu.be"];
const allowed=new Set([...defaults,...env.EXTRA_ALLOWED_DOMAINS]);
export function extractUrls(text?:string){if(!text)return[];const set=new Set<string>();for(const m of text.match(/https?:\/\/[^\s<>"']+/gi)??[]){try{const u=new URL(m.replace(/[),.;!?\]}]+$/g,""));if(["http:","https:"].includes(u.protocol))set.add(u.toString());}catch{}}return[...set];}
export function isAllowedMediaUrl(raw:string){if(env.ALLOW_GENERIC_URLS)return true;try{const host=new URL(raw).hostname.toLowerCase();for(const domain of allowed){const d=domain.replace(/^\*\./,"");if(host===d||host.endsWith(`.${d}`))return true;}return false;}catch{return false;}}
export function isYouTubeUrl(raw:string){try{return["youtube.com","www.youtube.com","m.youtube.com","youtu.be"].includes(new URL(raw).hostname.toLowerCase());}catch{return false;}}
export function normalizeUrl(raw:string){const u=new URL(raw);for(const k of [...u.searchParams.keys()])if(k.startsWith("utm_")||["igsh","igshid","si","ref","source"].includes(k))u.searchParams.delete(k);u.hash="";return u.toString();}
export const mediaCacheKey=(url:string,mode:string)=>createHash("sha256").update(`v6:${mode}:${normalizeUrl(url)}`).digest("hex");
