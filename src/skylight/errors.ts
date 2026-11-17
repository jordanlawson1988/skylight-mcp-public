export class ValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ValidationError";
    this.field = field;
  }
}

/** "session_expired": Skylight refused the refresh token (400/401), so only a new sign-in helps. */
export type AuthErrorCode = "session_expired";

export class AuthError extends Error {
  readonly code: AuthErrorCode | undefined;
  constructor(message: string, code?: AuthErrorCode) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

export class SkylightApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  constructor(status: number, method: string, path: string, message: string) {
    super(message);
    this.name = "SkylightApiError";
    this.status = status;
    this.method = method;
    this.path = path;
  }
}
