export const hedgeLogger = {
  info: (msg: string, extra?: unknown) =>
    console.log(JSON.stringify({ level: "info", msg, extra })),
  warn: (msg: string, extra?: unknown) =>
    console.warn(JSON.stringify({ level: "warn", msg, extra })),
  error: (msg: string, extra?: unknown) =>
    console.error(JSON.stringify({ level: "error", msg, extra })),
};
