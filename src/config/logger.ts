import pino from "pino";
import { env } from "./env.js";

const options: pino.LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { service: "esqueletops-nova", environment: env.NODE_ENV },
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
};

export const logger = env.NODE_ENV === "development"
  ? pino({
      ...options,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      },
    })
  : pino(options, pino.destination({ dest: 1, sync: false }));
