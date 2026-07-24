export function verifySessionToken(token: string): boolean {
  return token.startsWith('session_');
}
