import { useId } from 'react';
import { CreditCardIcon } from '@phosphor-icons/react/dist/ssr';

/**
 * Each network's mark as a single 24x24 path, white on the network's colour.
 *
 * The paths are copied from Simple Icons 16.36.0 (simpleicons.org, CC0), so
 * there is no dependency to keep current. The marks themselves remain their
 * networks' trademarks, shown here only to identify the card on file.
 * UnionPay is not in Simple Icons, and JCB and Diners Club have only
 * one-colour versions there, where their own marks are in colour; all three
 * fall back to the generic card until they are drawn from the networks' files.
 *
 * Three brands are drawn by components of their own below, because their
 * marks are not a white shape on the brand colour: Mastercard's is in three
 * colours, American Express's is a blue box with the lettering knocked out,
 * and Discover's is a dark wordmark on white with an orange O.
 */
const MARKS: Record<string, { tile: string; path: string }> = {
  visa: {
    tile: 'bg-card-visa',
    path: 'M9.112 8.262L5.97 15.758H3.92L2.374 9.775c-.094-.368-.175-.503-.461-.658C1.447 8.864.677 8.627 0 8.479l.046-.217h3.3a.904.904 0 01.894.764l.817 4.338 2.018-5.102zm8.033 5.049c.008-1.979-2.736-2.088-2.717-2.972.006-.269.262-.555.822-.628a3.66 3.66 0 011.913.336l.34-1.59a5.207 5.207 0 00-1.814-.333c-1.917 0-3.266 1.02-3.278 2.479-.012 1.079.963 1.68 1.698 2.04.756.367 1.01.603 1.006.931-.005.504-.602.725-1.16.734-.975.015-1.54-.263-1.992-.473l-.351 1.642c.453.208 1.289.39 2.156.398 2.037 0 3.37-1.006 3.377-2.564m5.061 2.447H24l-1.565-7.496h-1.656a.883.883 0 00-.826.55l-2.909 6.946h2.036l.405-1.12h2.488zm-2.163-2.656l1.02-2.815.588 2.815zm-8.16-4.84l-1.603 7.496H8.34l1.605-7.496z',
  },
};

export type CardBrandMarkProps = {
  /** Stripe's `card.brand`, such as `visa` or `amex`. */
  brand: string;
};

/**
 * A card network's mark in a small square tile of the network's colour, the
 * way Stripe's own portal lists a saved card.
 *
 * Keyed by Stripe's spelling of `card.brand`, so a brand passes straight
 * through from the API. A brand with no mark here (`jcb`, `diners`,
 * `unionpay`, `eftpos_au`, `link`, `unknown`, or one Stripe adds later) gets a grey tile with the card
 * glyph, the same size, so the row never shifts with the brand. Decorative:
 * the brand is written out in the text beside it.
 */
export function CardBrandMark({ brand }: CardBrandMarkProps) {
  const key = brand.toLowerCase();
  if (key === 'mastercard') return <MastercardMark />;
  if (key === 'amex') return <AmexMark />;
  if (key === 'discover') return <DiscoverMark />;
  const mark = Object.hasOwn(MARKS, key) ? MARKS[key] : undefined;

  if (!mark) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-zinc-200 text-zinc-600"
      >
        <CreditCardIcon size={18} />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md text-white ${mark.tile}`}
    >
      <svg viewBox="0 0 24 24" width={26} height={26} fill="currentColor" focusable="false">
        <path d={mark.path} />
      </svg>
    </span>
  );
}

/**
 * Mastercard's symbol in its three colours: two circles, red and yellow, and
 * orange where they overlap. On a dark tile, the background Mastercard allows
 * besides white, so it sits with the other brands' coloured tiles.
 *
 * The circles are 12 units across with their centres 7.44 apart, which makes
 * the symbol 1.62 times as wide as it is tall, the proportion of the real one.
 * The overlap is the yellow circle clipped to the red one; the clip needs an
 * id unique on the page, since more than one card can be listed.
 */
function MastercardMark() {
  const clipId = useId();

  return (
    <span
      aria-hidden="true"
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-zinc-900"
    >
      <svg viewBox="0 0 24 24" width={26} height={26} focusable="false">
        <defs>
          <clipPath id={clipId}>
            <circle cx={8.28} cy={12} r={6} />
          </clipPath>
        </defs>
        <circle cx={8.28} cy={12} r={6} fill="var(--color-card-mastercard-red)" />
        <circle cx={15.72} cy={12} r={6} fill="var(--color-card-mastercard-yellow)" />
        <circle
          cx={15.72}
          cy={12}
          r={6}
          fill="var(--color-card-mastercard-orange)"
          clipPath={`url(#${clipId})`}
        />
      </svg>
    </span>
  );
}

/** The blue box with its lettering knocked out (Simple Icons' path). */
const AMEX_PATH =
  'M16.015 14.378c0-.32-.135-.496-.344-.622-.21-.12-.464-.135-.81-.135h-1.543v2.82h.675v-1.027h.72c.24 0 .39.024.478.125.12.13.104.38.104.55v.35h.66v-.555c-.002-.25-.017-.376-.108-.516-.06-.08-.18-.18-.33-.234l.02-.008c.18-.072.48-.297.48-.747zm-.87.407l-.028-.002c-.09.053-.195.058-.33.058h-.81v-.63h.824c.12 0 .24 0 .33.05.098.048.156.147.15.255 0 .12-.045.215-.134.27zM20.297 15.837H19v.6h1.304c.676 0 1.05-.278 1.05-.884 0-.28-.066-.448-.187-.582-.153-.133-.392-.193-.73-.207l-.376-.015c-.104 0-.18 0-.255-.03-.09-.03-.15-.105-.15-.21 0-.09.017-.166.09-.21.083-.046.177-.066.272-.06h1.23v-.602h-1.35c-.704 0-.958.437-.958.84 0 .9.776.855 1.407.87.104 0 .18.015.225.06.046.03.082.106.082.18 0 .077-.035.15-.08.18-.06.053-.15.07-.277.07zM0 0v10.096L.81 8.22h1.75l.225.464V8.22h2.043l.45 1.02.437-1.013h6.502c.295 0 .56.057.756.236v-.23h1.787v.23c.307-.17.686-.23 1.12-.23h2.606l.24.466v-.466h1.918l.254.465v-.466h1.858v3.948H20.87l-.36-.6v.585h-2.353l-.256-.63h-.583l-.27.614h-1.213c-.48 0-.84-.104-1.08-.24v.24h-2.89v-.884c0-.12-.03-.12-.105-.135h-.105v1.036H6.067v-.48l-.21.48H4.69l-.202-.48v.465H2.235l-.256-.624H1.4l-.256.624H0V24h23.786v-7.108c-.27.135-.613.18-.973.18H21.09v-.255c-.21.165-.57.255-.914.255H14.71v-.9c0-.12-.018-.12-.12-.12h-.075v1.022h-1.8v-1.066c-.298.136-.643.15-.928.136h-.214v.915h-2.18l-.54-.617-.57.6H4.742v-3.93h3.61l.518.602.554-.6h2.412c.28 0 .74.03.942.225v-.24h2.177c.202 0 .644.045.903.225v-.24h3.265v.24c.163-.164.508-.24.803-.24h1.89v.24c.194-.15.464-.24.84-.24h1.176V0H0zM21.156 14.955c.004.005.006.012.01.016.01.01.024.01.032.02l-.042-.035zM23.828 13.082h.065v.555h-.065zM23.865 15.03v-.005c-.03-.025-.046-.048-.075-.07-.15-.153-.39-.215-.764-.225l-.36-.012c-.12 0-.194-.007-.27-.03-.09-.03-.15-.105-.15-.21 0-.09.03-.16.09-.204.076-.045.15-.05.27-.05h1.223v-.588h-1.283c-.69 0-.96.437-.96.84 0 .9.78.855 1.41.87.104 0 .18.015.224.06.046.03.076.106.076.18 0 .07-.034.138-.09.18-.045.056-.136.07-.27.07h-1.288v.605h1.287c.42 0 .734-.118.9-.36h.03c.09-.134.135-.3.135-.523 0-.24-.045-.39-.135-.526zM18.597 14.208v-.583h-2.235V16.458h2.235v-.585h-1.57v-.57h1.533v-.584h-1.532v-.51M13.51 8.787h.685V11.6h-.684zM13.126 9.543l-.007.006c0-.314-.13-.5-.34-.624-.217-.125-.47-.135-.81-.135H10.43v2.82h.674v-1.034h.72c.24 0 .39.03.487.12.122.136.107.378.107.548v.354h.677v-.553c0-.25-.016-.375-.11-.516-.09-.107-.202-.19-.33-.237.172-.07.472-.3.472-.75zm-.855.396h-.015c-.09.054-.195.056-.33.056H11.1v-.623h.825c.12 0 .24.004.33.05.09.04.15.128.15.25s-.047.22-.134.266zM15.92 9.373h.632v-.6h-.644c-.464 0-.804.105-1.02.33-.286.3-.362.69-.362 1.11 0 .512.123.833.36 1.074.232.238.645.31.97.31h.78l.255-.627h1.39l.262.627h1.36v-2.11l1.272 2.11h.95l.002.002V8.786h-.684v1.963l-1.18-1.96h-1.02V11.4L18.11 8.744h-1.004l-.943 2.22h-.3c-.177 0-.362-.03-.468-.134-.125-.15-.186-.36-.186-.662 0-.285.08-.51.194-.63.133-.135.272-.165.516-.165zm1.668-.108l.464 1.118v.002h-.93l.466-1.12zM2.38 10.97l.254.628H4V9.393l.972 2.205h.584l.973-2.202.015 2.202h.69v-2.81H6.118l-.807 1.904-.876-1.905H3.343v2.663L2.205 8.787h-.997L.01 11.597h.72l.26-.626h1.39zm-.688-1.705l.46 1.118-.003.002h-.915l.457-1.12zM11.856 13.62H9.714l-.85.923-.825-.922H5.346v2.82H8l.855-.932.824.93h1.302v-.94h.838c.6 0 1.17-.164 1.17-.945l-.006-.003c0-.78-.598-.93-1.128-.93zM7.67 15.853l-.014-.002H6.02v-.557h1.47v-.574H6.02v-.51H7.7l.733.82-.764.824zm2.642.33l-1.03-1.147 1.03-1.108v2.253zm1.553-1.258h-.885v-.717h.885c.24 0 .42.098.42.344 0 .243-.15.372-.42.372zM9.967 9.373v-.586H7.73V11.6h2.237v-.58H8.4v-.564h1.527V9.88H8.4v-.507';

/**
 * American Express's blue box, filling the tile. The path is the box with the
 * letters cut out of it, so it is drawn in the brand blue over white and the
 * letters show white through it. Filled white on a blue tile, as the other
 * marks are, it read the wrong way round: a white box with blue letters.
 */
function AmexMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-8 shrink-0 overflow-hidden rounded-md bg-white"
    >
      <svg
        viewBox="0 0 24 24"
        width={32}
        height={32}
        fill="var(--color-card-amex)"
        focusable="false"
        preserveAspectRatio="none"
      >
        <path d={AMEX_PATH} />
      </svg>
    </span>
  );
}

/** The wordmark (Simple Icons' path); its first subpath is the O. */
const DISCOVER_PATH =
  'M14.58 12a2.023 2.023 0 1 1-2.025-2.023h.002c1.118 0 2.023.906 2.023 2.023zm-5.2-2.001c-1.124 0-2.025.884-2.025 1.99 0 1.118.878 1.984 2.007 1.984.319 0 .593-.063.93-.221v-.873c-.296.297-.559.416-.895.416-.747 0-1.277-.542-1.277-1.312 0-.73.547-1.306 1.243-1.306.354 0 .622.126.93.428v-.873a1.898 1.898 0 0 0-.913-.233zm-3.352 1.545c-.445-.165-.576-.273-.576-.479 0-.239.233-.422.553-.422.222 0 .405.091.598.308l.388-.508a1.665 1.665 0 0 0-1.117-.422c-.673 0-1.186.467-1.186 1.089 0 .524.239.792.936 1.043.291.103.438.171.513.217a.456.456 0 0 1 .222.394c0 .308-.245.536-.576.536-.354 0-.639-.177-.809-.507l-.479.461c.342.502.752.724 1.317.724.771 0 1.311-.513 1.311-1.249-.002-.603-.252-.876-1.095-1.185zM24 10.3a.29.29 0 0 1-.288.291.29.29 0 0 1-.291-.291v-.003A.29.29 0 1 1 24 10.3zm-.059.001a.235.235 0 0 0-.231-.239.234.234 0 0 0-.232.239c0 .132.104.239.232.239a.235.235 0 0 0 .231-.239zM3.472 13.887h.742v-3.803h-.742v3.803zm12.702-1.248l-1.014-2.554h-.81l1.614 3.9h.399l1.643-3.9h-.804l-1.028 2.554zm2.166 1.248h2.104v-.644h-1.362v-1.027h1.312v-.644h-1.312v-.844h1.362v-.644H18.34v3.803zm5.409-3.557l.11.138h-.097l-.094-.13v.13h-.08v-.334h.107c.081 0 .126.036.126.103.001.046-.025.08-.072.093zm-.006-.092c0-.029-.021-.043-.06-.043h-.014v.087h.014c.039 0 .06-.014.06-.044zm-1.228 2.047l1.197 1.602H22.8l-1.027-1.528h-.097v1.528h-.741v-3.803h1.1c.855 0 1.346.411 1.346 1.123 0 .583-.308.965-.866 1.078zm.103-1.038c0-.37-.251-.563-.713-.563h-.228v1.152h.217c.473-.001.724-.207.724-.589zm-19.487.742a1.91 1.91 0 0 1-.69 1.46c-.365.303-.781.439-1.357.439H.001v-3.803H1.09c1.202 0 2.041.781 2.041 1.904zm-.764-.006c0-.364-.154-.718-.411-.947-.245-.222-.536-.308-1.015-.308H.742v2.515h.199c.479 0 .782-.092 1.015-.302.256-.228.411-.593.411-.958z';

/**
 * Discover's wordmark, dark on a white tile, with the O in Discover orange.
 * The orange is a circle drawn over the wordmark's own O, at its centre and
 * radius in the path. A white tile needs a border, or it vanishes into the
 * white card behind it.
 */
function DiscoverMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-white"
    >
      <svg viewBox="0 0 24 24" width={26} height={26} focusable="false">
        <path d={DISCOVER_PATH} className="fill-zinc-900" />
        <circle cx={12.555} cy={12} r={2.023} fill="var(--color-card-discover)" />
      </svg>
    </span>
  );
}
