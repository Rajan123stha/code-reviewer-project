// Axis math for the charts. Pure functions, unit-tested.

/** Round tick values from 0 to at least `max`: steps of 1, 2 or 5 times a power of ten. */
export function niceTicks(max: number, target = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / target;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  const ticks: number[] = [];
  for (let v = 0; v < max + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  if (ticks[ticks.length - 1]! < max) ticks.push(Number((ticks.length * step).toPrecision(12)));
  return ticks;
}

/** Indices of at most `max` evenly spaced labels, always including the first and last. */
export function labelIndices(length: number, max: number): number[] {
  if (length <= max) return Array.from({ length }, (_, i) => i);
  const step = Math.ceil((length - 1) / (max - 1));
  const out: number[] = [];
  for (let i = 0; i < length - 1; i += step) out.push(i);
  if (length - 1 - out[out.length - 1]! < step / 2) out.pop();
  out.push(length - 1);
  return out;
}
