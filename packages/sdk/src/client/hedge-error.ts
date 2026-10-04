import type { Checkpoint } from "../types/adapter.types";
export class HedgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly checkpoint?: Checkpoint,
  ) {
    super(message);
    this.name = "HedgeError";
  }
}
export class PendingError extends HedgeError {
  constructor(message: string, checkpoint: Checkpoint) {
    super("PENDING", message, checkpoint);
    this.name = "PendingError";
  }
}
