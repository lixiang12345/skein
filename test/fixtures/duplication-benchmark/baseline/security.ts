export function authorizeRecords(records: Array<{owner: string; value: number}>, actor: string) {
  const accepted = [];
  for (const record of records) {
    if (record.owner !== actor) continue;
    if (!Number.isFinite(record.value)) throw new Error('invalid value');
    accepted.push({owner: record.owner, value: Math.max(0, record.value)});
  }
  if (!accepted.length) throw new Error('permission denied');
  return accepted;
}
