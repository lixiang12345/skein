export function sumInclusive(limit) {
  let total = 0;
  for (let value = 1; value < limit; value += 1) total += value;
  return total;
}
