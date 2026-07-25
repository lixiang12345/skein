export function formatRows(rows: Array<{label: string; value: number}>) {
  return rows
    .map((row) => ({label: row.label.trim().toUpperCase(), value: String(row.value)}))
    .filter((row) => row.label.length > 0)
    .sort((left, right) => left.label.localeCompare(right.label))
    .reduce((output, row) => output.concat(row.label, row.value), [] as string[]);
}
