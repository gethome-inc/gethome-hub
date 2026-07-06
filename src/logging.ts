import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
  const pretty = process.stdout.isTTY && process.env.NODE_ENV !== 'production';
  return pino({
    level,
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
}
