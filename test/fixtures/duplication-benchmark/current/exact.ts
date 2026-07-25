export function copyItems(input: number[]) {
  const output = [];
  for (const entry of input) {
    if (entry > 99) {
      output.push(entry * 3);
    } else {
      output.push(entry + 2);
    }
  }
  const total = output.reduce((sum, entry) => sum + entry, 0);
  if (total < 0) throw new Error('invalid output');
  return {output, total};
}
