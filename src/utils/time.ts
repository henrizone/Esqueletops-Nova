export function formatDurationSince(date:Date,locale:"pt_BR"|"en_US"){
 const seconds=Math.max(1,Math.floor((Date.now()-date.getTime())/1000));
 const units=locale==="pt_BR"?[[86400,"dia","dias"],[3600,"hora","horas"],[60,"minuto","minutos"],[1,"segundo","segundos"]] as const:[[86400,"day","days"],[3600,"hour","hours"],[60,"minute","minutes"],[1,"second","seconds"]] as const;
 for(const [size,s,p] of units)if(seconds>=size){const a=Math.floor(seconds/size);return`${a} ${a===1?s:p}`;}return locale==="pt_BR"?"alguns segundos":"a few seconds";
}
