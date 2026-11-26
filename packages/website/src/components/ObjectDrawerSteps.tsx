import { useId } from 'react';
import { CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react/dist/ssr';

import { IconButton } from './IconButton';
import { Tooltip } from './Tooltip';

/** The objects before and after this one in the list, for stepping without closing. */
export type ObjectDrawerSiblings = {
  /** 1-based, as the header shows it. */
  position: number;
  total: number;
  onPrevious?: () => void;
  onNext?: () => void;
};

/** The same steps, each also calling `onStep`. */
export function trackSteps(
  siblings: ObjectDrawerSiblings,
  onStep: () => void,
): ObjectDrawerSiblings {
  const { onPrevious, onNext } = siblings;
  return {
    ...siblings,
    onPrevious:
      onPrevious &&
      (() => {
        onStep();
        onPrevious();
      }),
    onNext:
      onNext &&
      (() => {
        onStep();
        onNext();
      }),
  };
}

// Keys these elements use themselves: the caret in a field, scrolling a text
// preview, seeking in a player. Stepping on them would take the object away.
const KEYS_KEPT_BY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'PRE', 'VIDEO', 'AUDIO']);
// Lower and upper case, so Caps Lock does not turn the letters off
const PREVIOUS_KEYS = new Set(['ArrowUp', 'k', 'K']);
const NEXT_KEYS = new Set(['ArrowDown', 'j', 'J']);

/**
 * Up and down (or k and j, as in Linear) step to the neighbouring object, when
 * focus is in the panel or on the dialog root it sits in.
 *
 * React passes a key pressed in a dialog opened from the panel, such as the
 * Delete confirmation or Share, up to this handler although that dialog is
 * elsewhere in the page. Stepping then would put another object behind it, so a
 * key from outside the panel is ignored.
 */
export function handleStepKey(
  e: React.KeyboardEvent,
  panel: HTMLElement | null,
  siblings?: ObjectDrawerSiblings,
) {
  if (!siblings || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const { target } = e;
  if (!(target instanceof Node)) return;
  if (target !== e.currentTarget && !panel?.contains(target)) return;
  if (
    target instanceof HTMLElement &&
    (KEYS_KEPT_BY_TAGS.has(target.tagName) || target.isContentEditable)
  ) {
    return;
  }
  const step = PREVIOUS_KEYS.has(e.key)
    ? siblings.onPrevious
    : NEXT_KEYS.has(e.key)
      ? siblings.onNext
      : undefined;
  if (!step) return;
  e.preventDefault();
  step();
}

export function SiblingSteps({
  siblings,
  announcement,
}: {
  siblings: ObjectDrawerSiblings;
  announcement: string;
}) {
  return (
    <div className="mr-1 flex items-center gap-1 border-r border-zinc-100 pr-2">
      {/* Where this object sits in the folder, as Linear's issue view counts its list */}
      <span
        data-testid="object-details-drawer-position"
        className="mr-1 hidden text-xs text-zinc-500 tabular-nums sm:inline"
      >
        {siblings.position} / {siblings.total}
      </span>
      {/* Stepping keeps focus where it is, so nothing else tells a screen reader
          that the object changed */}
      <p data-testid="object-details-drawer-announcement" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <StepButton
        icon={CaretUpIcon}
        label="Previous object"
        keys={PREVIOUS_KEY_HINT}
        testId="object-details-drawer-previous"
        onStep={siblings.onPrevious}
      />
      <StepButton
        icon={CaretDownIcon}
        label="Next object"
        keys={NEXT_KEY_HINT}
        testId="object-details-drawer-next"
        onStep={siblings.onNext}
      />
    </div>
  );
}

type KeyHint = {
  /** As the tooltip shows it. */
  shown: string;
  /** As a screen reader reads it. */
  spoken: string;
  /** In the `aria-keyshortcuts` syntax. */
  shortcuts: string;
};

const PREVIOUS_KEY_HINT: KeyHint = {
  shown: '↑ or K',
  spoken: 'Up arrow or K',
  shortcuts: 'ArrowUp K',
};
const NEXT_KEY_HINT: KeyHint = {
  shown: '↓ or J',
  spoken: 'Down arrow or J',
  shortcuts: 'ArrowDown J',
};

/**
 * Previous or Next, naming its keys in the tooltip and to screen readers.
 *
 * At the first or last object it is `aria-disabled` rather than `disabled`: a
 * disabled button drops the focus it holds, out of the panel, and the keys would
 * stop working after Next reached the end.
 */
function StepButton({
  icon,
  label,
  keys,
  testId,
  onStep,
}: {
  icon: typeof CaretUpIcon;
  label: string;
  keys: KeyHint;
  testId: string;
  onStep?: () => void;
}) {
  const hintId = useId();
  return (
    <Tooltip
      side="bottom"
      content={
        <span className="flex items-center gap-2">
          {label}
          <span className="text-zinc-500">{keys.shown}</span>
        </span>
      }
    >
      <IconButton
        icon={icon}
        data-testid={testId}
        aria-label={label}
        aria-keyshortcuts={keys.shortcuts}
        aria-describedby={hintId}
        aria-disabled={!onStep || undefined}
        className="focus-visible:brand-outline aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        onClick={onStep}
      />
      <span id={hintId} className="sr-only">
        Shortcut: {keys.spoken}
      </span>
    </Tooltip>
  );
}
