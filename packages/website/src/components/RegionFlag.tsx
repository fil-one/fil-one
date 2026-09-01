// Country flags for the storage regions, drawn as inline SVG rather than emoji:
// Windows Chrome doesn't render regional-indicator pairs, so 🇫🇷 shows up there
// as the letters "FR". Simplified at this size (the US canton carries a star
// texture rather than 50 countable stars).

import { S3Region, getRegionLabel } from '@filone/shared';

const STRIPE = 12 / 13;
const US_STRIPES = [0, 2, 4, 6, 8, 10, 12].map((i) => i * STRIPE);
const US_STARS = Array.from({ length: 5 }, (_, row) =>
  Array.from({ length: 5 }, (_, col) => ({
    // Odd rows sit half a column in, which reads as the real staggered grid.
    cx: 0.7 + col * 1.24 + (row % 2 === 1 ? 0.62 : 0),
    cy: 0.75 + row * 1.24,
  })),
).flat();

function FranceFlag() {
  return (
    <>
      <rect width="16" height="12" fill="#fff" />
      <rect width="5.34" height="12" fill="#002654" />
      <rect x="10.66" width="5.34" height="12" fill="#ED2939" />
    </>
  );
}

function NetherlandsFlag() {
  return (
    <>
      <rect width="16" height="12" fill="#fff" />
      <rect width="16" height="4" fill="#AE1C28" />
      <rect y="8" width="16" height="4" fill="#21468B" />
    </>
  );
}

function UnitedStatesFlag() {
  return (
    <>
      <rect width="16" height="12" fill="#fff" />
      {US_STRIPES.map((y) => (
        <rect key={y} y={y} width="16" height={STRIPE} fill="#B31942" />
      ))}
      <rect width="6.4" height={STRIPE * 7} fill="#0A3161" />
      {US_STARS.map((star) => (
        <circle key={`${star.cx}-${star.cy}`} cx={star.cx} cy={star.cy} r="0.26" fill="#fff" />
      ))}
    </>
  );
}

const FLAGS: Record<S3Region, () => React.JSX.Element> = {
  [S3Region.EuWest1]: FranceFlag,
  [S3Region.UsEast1]: UnitedStatesFlag,
  [S3Region.EuCentral3]: NetherlandsFlag,
  [S3Region.UsEast9]: UnitedStatesFlag,
};

type RegionFlagProps = {
  region: string;
  className?: string;
};

/**
 * Flag for a storage region. Renders nothing for an unrecognized region code so
 * a new region ships as label-only rather than as a broken glyph.
 */
export function RegionFlag({ region, className }: RegionFlagProps) {
  const Flag = FLAGS[region as S3Region];
  if (!Flag) return null;

  return (
    <svg
      viewBox="0 0 16 12"
      width="16"
      height="12"
      role="img"
      aria-label={getRegionLabel(region)}
      // The inset ring keeps the white edges of the French and Dutch flags from
      // dissolving into the white table row.
      className={`shrink-0 overflow-hidden rounded-[2px] ring-1 ring-inset ring-black/10 ${className ?? ''}`}
    >
      <Flag />
    </svg>
  );
}
