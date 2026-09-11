/**
 * Hand the browser a file to save.
 *
 * Takes a `Blob` rather than a string, because the two callers want different
 * things: a credentials modal builds its file locally from a value already on
 * screen, and the audit export receives one from the API. Both end at the same
 * object URL and the same synthetic click.
 *
 * The URL is revoked straight after the click. It is a reference into this
 * document that outlives the download otherwise, and for the credentials flows
 * what it references is a secret.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The same, for a file built here rather than fetched. */
export function downloadText(content: string, filename: string, type: string): void {
  downloadBlob(new Blob([content], { type }), filename);
}
