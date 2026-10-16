/**
 * Y-axis scales for the usage charts.
 *
 * Recharts' `domain={['dataMin', 'dataMax']}` is wrong for both chart types we
 * draw. On a bar chart it moves the baseline off zero, so a day at the series
 * minimum draws a zero-height bar and reads as "no data" — four of seven days
 * vanished this way on the dashboard. On an area chart it truncates the fill,
 * so an 18 → 27 MB week reads as a cliff. Both charts start at zero instead,
 * on a rounded domain with evenly spaced ticks.
 */

/** Step sizes are drawn from these multiples of a power of ten. */
const STEP_MULTIPLES = [1, 2, 2.5, 5, 10];

export type NiceScale = {
  /** Upper bound of the axis: `[0, domainMax]`. */
  domainMax: number;
  /** Evenly spaced tick values, starting at 0 and ending at `domainMax`. */
  ticks: number[];
};

export type NiceScaleOptions = {
  /**
   * Roughly how many ticks to aim for, inclusive of the 0 baseline. The step is
   * rounded to a human number and the domain is then tightened to the data, so
   * the result lands near this count rather than exactly on it.
   */
  tickCount?: number;
  /** Force a whole-number step, for counts that cannot be fractional. */
  integer?: boolean;
};

/**
 * A zero-based axis whose ticks are evenly spaced and land on round numbers.
 *
 * `domainMax` is the first multiple of the step at or above `max`, so the
 * series fills the plot without clipping and without leaving most of the axis
 * empty above it.
 */
export function niceScale(max: number, options: NiceScaleOptions = {}): NiceScale {
  const { tickCount = 5, integer = false } = options;
  const intervals = Math.max(1, tickCount - 1);

  // An all-zero window (a new org, or a quiet week) has no range to round. A
  // single 0 tick says "nothing here" without inventing a scale to say it on.
  if (!Number.isFinite(max) || max <= 0) {
    return { domainMax: 1, ticks: [0] };
  }

  const targetStep = max / intervals;
  const magnitude = Math.pow(10, Math.floor(Math.log10(targetStep)));
  const multiple = STEP_MULTIPLES.find((m) => m * magnitude >= targetStep) ?? 10;
  let step = multiple * magnitude;
  if (integer) step = Math.max(1, Math.ceil(step));

  const steps = Math.ceil(roundFloat(max / step));
  const ticks = Array.from({ length: steps + 1 }, (_, i) => roundFloat(step * i));

  return { domainMax: ticks[steps], ticks };
}

/**
 * Floating-point steps accumulate visible error (0.1 * 3 is
 * 0.30000000000000004), and a tick label is the one place it would show.
 */
function roundFloat(n: number): number {
  return Number(n.toPrecision(12));
}
