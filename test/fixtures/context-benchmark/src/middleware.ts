import validate from './security/token.js';

export function authorizeRequest(value: string): boolean {
  return validate(value);
}
