import type { SuperQiErrorCode } from "./types";

export class SuperQiError extends Error {
  readonly code: SuperQiErrorCode;

  constructor(code: SuperQiErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SuperQiError";
    this.code = code;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    Object.setPrototypeOf(this, SuperQiError.prototype);
  }
}

export function isSuperQiError(error: unknown, code?: SuperQiErrorCode): error is SuperQiError {
  return error instanceof SuperQiError && (code === undefined || error.code === code);
}
