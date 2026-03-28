export type LogLevel = "debug" | "info" | "warn" | "error";

const order: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(current: LogLevel, requested: LogLevel): boolean {
  return order[requested] >= order[current];
}

function format(level: LogLevel, message: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  const base = `[${ts}] ${level.toUpperCase()} ${message}`;
  return meta === undefined ? base : `${base} ${JSON.stringify(meta)}`;
}

export function createLogger(level: LogLevel = "info") {
  return {
    debug(message: string, meta?: unknown) {
      if (shouldLog(level, "debug")) console.debug(format("debug", message, meta));
    },
    info(message: string, meta?: unknown) {
      if (shouldLog(level, "info")) console.info(format("info", message, meta));
    },
    warn(message: string, meta?: unknown) {
      if (shouldLog(level, "warn")) console.warn(format("warn", message, meta));
    },
    error(message: string, meta?: unknown) {
      if (shouldLog(level, "error")) console.error(format("error", message, meta));
    },
  };
}
