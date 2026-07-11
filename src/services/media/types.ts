export type DownloadMode="auto"|"video"|"audio";export type MediaKind="photo"|"video"|"audio"|"document";
export interface MediaMetadata{id?:string;title?:string;description?:string;uploader?:string;uploaderId?:string;duration?:number;webpageUrl?:string;thumbnail?:string;extractor?:string;}
export interface PreparedMediaItem{path:string;kind:MediaKind;filename:string;size:number;}
export interface CachedMediaItem{kind:MediaKind;fileId:string;filename?:string;}
export interface CachedMediaPayload{items:CachedMediaItem[];metadata:MediaMetadata;cachedAt:string;}
export interface DownloadRequest{url:string;mode:DownloadMode;automatic:boolean;requesterId:number;chatId:number;replyToMessageId?:number;captionEnabled:boolean;errorMessagesEnabled:boolean;deleteSource:boolean;sourceMessageId?:number;}
