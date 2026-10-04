/** HTTP and BSON carry integer base units as decimal strings, never floating point. */
export function httpJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ) ?? "null",
  ) as unknown;
}
