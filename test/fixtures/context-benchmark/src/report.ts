export function formatSessionAudit(rows: Array<{sessionId: string}>): string[] {
  return rows.map((row) => row.sessionId);
}
