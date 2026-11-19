import { useEffect, useRef, useState } from 'react';

/** The pause in the typing after which the search text goes to the URL. */
const searchPause = 300;

/**
 * The text of the search field. The field shows each key at once, and `onSearch` gets the text after a short pause in
 * the typing, so that the page does not read the orders on each key. A change of `q` from outside, such as the back
 * button or a link, replaces the text and cancels a search that waits. The return of the last search in `q` is not a
 * change from outside, so the keys typed after it stay.
 */
export function useSearchText(q: string, onSearch: (q: string) => void) {
  const [text, setText] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The last text that went to `onSearch`, until it comes back in `q`. */
  const sent = useRef<string>(undefined);

  useEffect(() => {
    const own = q === sent.current;
    sent.current = undefined;
    if (own) return;
    clearTimeout(timer.current);
    setText(q);
  }, [q]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return {
    text,
    /** Shows the text at once, and searches for it after the pause. */
    change: (next: string) => {
      setText(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        sent.current = next;
        onSearch(next);
      }, searchPause);
    },
    /** Empties the field and cancels a search that waits, for the clear button. */
    reset: () => {
      clearTimeout(timer.current);
      setText('');
    },
  };
}
