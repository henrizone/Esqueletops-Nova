import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "esqueletops-nova", environment: env.NODE_ENV },
  transport: env.NODE_ENV === "development" ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" } } : undefined,
});
