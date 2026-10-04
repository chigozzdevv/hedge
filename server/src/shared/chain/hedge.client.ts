import {
  deploymentSchema,
  type DeploymentManifest,
  type LoanRequest,
  type Offer,
  type CreditSummary,
  type Chain,
} from "@hedge/schema";
import { sameAddress } from "@hedge/sdk";
import { observationSchema, type ChainObservation } from "./chain.schema.js";
import type { CollateralSummary, OperatorSummary } from "./hedge.schema.js";
import { HedgeHttpError } from "../http/http.errors.js";

/** Implementations must read configured contracts at confirmed blocks and verify
 * their code/peers. No signing keys or simulated contract implementation belong here. */
export interface HedgeReader {
  verifyDeployment(manifest: DeploymentManifest): Promise<void>;
  offers(request: LoanRequest): Promise<ChainObservation<Offer>[]>;
  offer(id: string): Promise<ChainObservation<Offer> | null>;
  credit(id: string): Promise<ChainObservation<CreditSummary> | null>;
  collateral(creditId: string): Promise<ChainObservation<CollateralSummary> | null>;
  operator(address: string): Promise<ChainObservation<OperatorSummary>>;
}
export interface HedgeChainConfig {
  manifest: DeploymentManifest;
  reader: HedgeReader;
}
export class HedgeChainClient {
  readonly manifest?: DeploymentManifest;
  private readonly reader?: HedgeReader;
  private verification?: Promise<void>;
  constructor(config?: HedgeChainConfig) {
    if (config) {
      this.manifest = deploymentSchema.parse(config.manifest);
      Object.freeze(this.manifest.hedera);
      Object.freeze(this.manifest.base);
      Object.freeze(this.manifest);
      this.reader = config.reader;
    }
  }
  async ready(): Promise<HedgeReader> {
    const reader = this.reader,
      manifest = this.manifest;
    if (!reader || !manifest) throw new HedgeHttpError(503, "hedge-reader-unconfigured");
    this.verification ??= Promise.resolve()
      .then(() => reader.verifyDeployment(manifest))
      .catch(() => {
        this.verification = undefined;
        throw new HedgeHttpError(503, "hedge-deployment-unavailable");
      });
    await this.verification;
    return reader;
  }
  validate<T>(value: ChainObservation<T>, chain: Chain): ChainObservation<T> {
    const metadata = this.parseData(observationSchema, {
      chainId: value.chainId,
      contract: value.contract,
      observedBlock: value.observedBlock,
      observedHash: value.observedHash,
    });
    const expected = this.manifest?.[chain];
    if (
      !expected ||
      metadata.chainId !== expected.chain_id ||
      !sameAddress(metadata.contract, expected.contract)
    )
      throw new HedgeHttpError(502, "hedge-observation-mismatch");
    return { ...metadata, data: value.data };
  }
  parseData<T>(schema: { parse(value: unknown): T }, value: unknown): T {
    try {
      return schema.parse(value);
    } catch {
      throw new HedgeHttpError(502, "hedge-observation-invalid");
    }
  }
  assertInstance(instanceId: string): void {
    if (instanceId !== this.manifest?.instance_id)
      throw new HedgeHttpError(502, "hedge-instance-mismatch");
  }
}
