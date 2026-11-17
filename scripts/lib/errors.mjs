export class KufarError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'KufarError';
    this.code = code;
    this.details = details;
  }
}
