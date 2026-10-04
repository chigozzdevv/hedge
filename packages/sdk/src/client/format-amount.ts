export function formatAmount(amount: bigint, decimals: number): string {
  if (amount < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 77)
    throw new RangeError("Invalid token amount or decimals");
  const scale = 10n ** BigInt(decimals);
  const integer = (amount / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}
