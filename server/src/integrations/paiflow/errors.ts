/**
 * `code` is Paiflow's error code (UNAUTHENTICATED, INSUFFICIENT_FUNDS, FORBIDDEN, NOT_FOUND,
 * CONFLICT, VALIDATION, RATE_LIMITED, INTERNAL, UPSTREAM_RPC) or one of ours:
 * NOT_CONFIGURED, FLOW_NOT_CONFIGURED, NETWORK (no response), TIMEOUT, BAD_RESPONSE.
 */
export class PaiflowError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number | undefined,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'PaiflowError';
  }

  /** True when Paiflow answered and refused the request, so nothing was sent to the network. */
  get refused(): boolean {
    return this.httpStatus !== undefined && this.httpStatus >= 400 && this.httpStatus < 500 && this.code !== 'RATE_LIMITED';
  }
}
