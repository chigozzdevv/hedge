import { idSchema, type Offer } from "@hedge/schema";
import type { ClientContext } from "../client/client-context";
import { Credit } from "../credit/credit";
import type { TokenAmount } from "../types/adapter.types";
import { HedgeError } from "../client/hedge-error";
import { sameAddress } from "../evm/address";
export class Operator {
  constructor(
    private readonly context: ClientContext,
    readonly address: string,
  ) {}
  async summary() {
    await this.context.ready();
    const result = await this.context.adapter.operatorSummary(this.address);
    this.context.instance(result.instance_id);
    if (!sameAddress(result.operator, this.address))
      throw new HedgeError("OPERATOR_MISMATCH", "Result belongs to another operator");
    return result;
  }
  async deposit(args: TokenAmount) {
    await this.context.ready();
    return this.context.transaction(
      await this.context.adapter.deposit(this.address, args),
      "hedera",
    );
  }
  async withdraw(args: TokenAmount) {
    await this.context.ready();
    return this.context.transaction(
      await this.context.adapter.withdraw(this.address, args),
      "hedera",
    );
  }
  async offers() {
    await this.context.ready();
    return (await this.context.adapter.operatorOffers(this.address)).map((value) => {
      const offer = this.context.offer(value);
      if (!sameAddress(offer.operator, this.address))
        throw new HedgeError("OPERATOR_MISMATCH", "Offer belongs to another operator");
      return offer;
    });
  }
  offer(id: string) {
    idSchema.parse(id);
    return {
      summary: async () => {
        await this.context.ready();
        const result = this.context.offer(await this.context.adapter.offer(id));
        if (result.id !== id || !sameAddress(result.operator, this.address))
          throw new HedgeError("OFFER_MISMATCH", "Result belongs to another offer");
        return result;
      },
      withdraw: async () => {
        await this.context.ready();
        return this.context.transaction(
          await this.context.adapter.withdrawOffer(this.address, id),
          "hedera",
        );
      },
    };
  }
  async publishOffer(terms: Offer) {
    await this.context.ready();
    if (!sameAddress(terms.operator, this.address))
      throw new HedgeError("OPERATOR_MISMATCH", "Offer belongs to another operator");
    return this.context.transaction(
      await this.context.adapter.publishOffer(this.address, this.context.offer(terms)),
      "hedera",
    );
  }
  credit(id: string) {
    const credit = new Credit(this.context, idSchema.parse(id));
    return {
      summary: () => credit.summary(),
      authorizeDefault: async () => {
        await this.context.ready();
        return this.context.transaction(
          await this.context.adapter.authorizeDefault(this.address, id),
          "hedera",
        );
      },
      claimCollateral: async () => {
        await this.context.ready();
        return this.context.transaction(
          await this.context.adapter.claimRecovery(this.address, id),
          "base",
        );
      },
    };
  }
}
