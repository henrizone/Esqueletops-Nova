export const commandAliases:Record<string,string>={sdl:"dl",clima:"weather",translate:"tr"};
export const disableableCommands=["dl","ytdl","kang","newpack","mypacks","switch","delpack","getsticker","afk","weather","tr","slap","ping","id"] as const;
export const normalizeCommand=(raw:string)=>{const x=raw.trim().toLowerCase().replace(/^\//,"").split("@")[0]??"";return commandAliases[x]??x;};
export const isDisableable=(c:string)=>(disableableCommands as readonly string[]).includes(normalizeCommand(c));
