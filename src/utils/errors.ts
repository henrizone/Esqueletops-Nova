import { nanoid } from "nanoid";
export const errorCode=(prefix="ERR")=>`${prefix}-${nanoid(7).toUpperCase()}`;
export const errorMessage=(error:unknown)=>error instanceof Error?error.message:String(error);
