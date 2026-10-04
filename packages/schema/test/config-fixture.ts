const address = `0x${"1".repeat(40)}` as const;
const hash = `0x${"2".repeat(64)}` as const;
const chain = { chain_id: 296, router: address, selector: "1", contract: address, code_hash: hash };
const deployment = {
  schema_version: 1,
  protocol_version: 3,
  instance_id: hash,
  build_id: "unit-test",
  deployer: address,
  hedera: { ...chain, contract_id: "0.0.123" },
  base: { ...chain, chain_id: 84532, selector: "2" },
};
export const testConfig = {
  schema_version: 1,
  deployment,
  operator: address,
  rpc: { hedera: "http://fixture.invalid", base: "http://fixture.invalid" },
  start_block: { hedera: "1", base: "1" },
  mirror_url: "https://fixture.invalid",
  operator_url: "http://127.0.0.1:3003/testnet",
};
const proof = {
  transaction_hash: hash,
  receipt_status: 1,
  block_number: "1",
  block_hash: hash,
  contract: address,
  code_hash: hash,
  instance_id: hash,
  compiled_runtime_matched: true,
};
export const testRecord = {
  ...testConfig,
  verification: { verified_at: "2026-10-03T00:00:00Z", hedera: proof, base: proof },
};
