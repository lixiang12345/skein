export function generatedItems(input: number[]) {
  const values = [];
  for (const item of input) {
    if (item > 10) values.push(item * 2);
    else values.push(item + 1);
  }
  const total = values.reduce((sum, item) => sum + item, 0);
  if (total < 0) throw new Error('invalid total');
  return {values, total};
}
