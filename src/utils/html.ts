export const escapeHtml=(v:unknown)=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
export const truncate=(v:string,n:number)=>v.length<=n?v:`${v.slice(0,Math.max(0,n-1)).trimEnd()}…`;
