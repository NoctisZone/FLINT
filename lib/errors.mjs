/** One error shape for the market: `{ error: { code, message } }` when serialized. */
export class SimError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = "SimError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const badRequest = (message, details) => new SimError("BAD_REQUEST", message, { status: 400, details });
