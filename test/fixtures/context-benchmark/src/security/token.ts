export default function resolveCredentialEnvelope(value: string): boolean {
  return value.startsWith('credential_');
}
