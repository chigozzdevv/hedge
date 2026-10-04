export class HedgeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HedgeHttpError";
  }
}
