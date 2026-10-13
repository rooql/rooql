export class RooqlError extends Error {
  constructor(code, message, path) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'RooqlError';
    this.code = code;
    if (path) this.path = path;
  }
}

export function fail(code, message, path) {
  throw new RooqlError(code, message, path);
}
