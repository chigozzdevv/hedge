import { z } from "zod";

/** Human-readable token units. Never convert amounts through a JavaScript number. */
export const decimalAmountSchema = z
  .string()
  .max(100)
  .regex(/^\d+(\.\d*)?$/);

export function parseAmount(value: string, decimals: number): bigint {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 77 ||
    !decimalAmountSchema.safeParse(value).success
  )
    throw new Error("Enter a valid amount.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  const amount =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (amount <= 0n || amount >= 2n ** 256n) throw new Error("Enter a valid amount.");
  return amount;
}
