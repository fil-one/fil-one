import { useState } from 'react';

import { useDebouncedValue } from './use-debounced-value.js';

/** Quiet time after the last keystroke before the folder is listed again. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * The search box of one folder: what is typed, and the settled text the listing
 * uses once typing pauses.
 *
 * A search belongs to the folder it was typed in, so opening another folder
 * starts with an empty box. Both values are tagged with their folder and read
 * as empty for any other, rather than cleared in an effect, so neither the box
 * nor the listing shows the old folder's search for a frame, or for the length
 * of the debounce.
 */
export function useFolderSearch(prefix: string) {
  const [typed, setTyped] = useState({ prefix, text: '' });
  const settled = useDebouncedValue(typed, SEARCH_DEBOUNCE_MS);

  return {
    text: typed.prefix === prefix ? typed.text : '',
    setText: (text: string) => setTyped({ prefix, text }),
    settledText: settled.prefix === prefix ? settled.text : '',
  };
}
