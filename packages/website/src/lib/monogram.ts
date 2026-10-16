/**
 * The one or two letters an avatar shows when there is no picture.
 *
 * Two initials when the name is a real name (first and last word), one when it
 * is a single token like an email address or a mononym, where a second letter
 * would be a slice of one word rather than an initial. Empty in, empty out, so
 * the avatar renders a bare circle rather than the letter of a fallback string.
 */
export function monogramFromName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0]!.charAt(0).toUpperCase();
  return (words[0]!.charAt(0) + words[words.length - 1]!.charAt(0)).toUpperCase();
}
