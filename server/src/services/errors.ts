/** A refusal or failure a route turns into `{ error: { code, message } }` with `status`. Messages are student-safe. */
export class ServiceError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}
