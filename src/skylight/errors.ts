export class ValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ValidationError";
    this.field = field;
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
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
