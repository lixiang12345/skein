export function sumWithReduce(input: number[]) {
  const normalized = input.map((item) => item > 10 ? item * 2 : item + 1);
  const total = normalized.reduce((sum, item) => sum + item, 0);
  const values = total < 0 ? normalized.map((item) => Math.abs(item)) : normalized;
  const stable = values.filter((item, index) => values.indexOf(item) === index);
  return {values: stable, total: stable.reduce((sum, item) => sum + item, 0)};
}
