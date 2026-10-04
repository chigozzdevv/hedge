export const env = {
  port: Number(process.env["PORT"] ?? 3003),
  host: process.env["HOST"] ?? "127.0.0.1",
  databaseDriver: process.env["DATABASE_DRIVER"] ?? "none",
  databaseUrl: process.env["DATABASE_URL"] ?? "",
  redisUrl: process.env["REDIS_URL"] ?? "",
  redisPrefix: process.env["REDIS_PREFIX"] ?? "hedge",
  corsOrigins: (process.env["CORS_ORIGINS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
};
export function assertServerConfig(): void {
  const operator = process.env["HEDGE_OPERATOR_ADDRESS"];
  if (operator && (!/^0x[0-9a-fA-F]{40}$/.test(operator) || /^0x0{40}$/i.test(operator)))
    throw new Error("HEDGE_OPERATOR_ADDRESS must be a nonzero EVM address");
  if (process.env["MONGO_URL"])
    throw new Error("Replace MONGO_URL with DATABASE_DRIVER=mongodb and DATABASE_URL");
  if (!Number.isInteger(env.port) || env.port < 1 || env.port > 65535 || !env.host.trim())
    throw new Error("server-config-invalid");
  if (!/^[a-zA-Z0-9_-]+$/.test(env.redisPrefix)) throw new Error("REDIS_PREFIX is invalid");
  if (!["none", "mongodb", "postgres"].includes(env.databaseDriver))
    throw new Error("DATABASE_DRIVER must be none, mongodb or postgres");
  if ((env.databaseDriver === "none") !== (env.databaseUrl === ""))
    throw new Error("Configure DATABASE_DRIVER and DATABASE_URL together");
  if (env.databaseDriver === "mongodb") {
    // A MongoDB seed list is not a WHATWG URL; permit multiple hosts and SRV URIs.
    if (!/^mongodb(?:\+srv)?:\/\/[^\s/]+\/[^\s/?]+(?:\?[^\s]*)?$/.test(env.databaseUrl))
      throw new Error("DATABASE_URL must identify a MongoDB database");
  }
  if (env.databaseDriver === "postgres") {
    let url: URL;
    try {
      url = new URL(env.databaseUrl);
    } catch {
      throw new Error("DATABASE_URL is invalid");
    }
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length < 2
    )
      throw new Error("DATABASE_URL must identify a PostgreSQL database");
  }
  for (const [name, value, protocols] of [
    ["REDIS_URL", env.redisUrl, ["redis:", "rediss:"]],
  ] as const) {
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} is invalid`);
    }
    if (!(protocols as readonly string[]).includes(url.protocol) || !url.hostname)
      throw new Error(`${name} is invalid`);
  }
  for (const value of env.corsOrigins) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("CORS_ORIGINS is invalid");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== value)
      throw new Error("CORS_ORIGINS is invalid");
  }
}
export function localTestOrigins(): string[] {
  const origins = env.corsOrigins.length
    ? env.corsOrigins
    : ["http://127.0.0.1:3000", "http://127.0.0.1:3002"];
  if (
    origins.some((origin) => {
      const url = new URL(origin);
      return url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port;
    })
  )
    throw new Error("Local test wallet requires explicit loopback frontend origins");
  return origins;
}
