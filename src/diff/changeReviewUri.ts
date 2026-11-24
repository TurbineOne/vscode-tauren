/**
 * Custom URI scheme used by Tauren's per-change diff review.
 *
 * VS Code's `vscode.diff` command compares documents by URI rather than raw
 * text strings. Registering a `TextDocumentContentProvider` for this scheme in
 * `ChangeReviewViewer` lets Tauren display proposed in-memory before-and-after
 * file contents in a native diff editor without writing temporary files to disk.
 *
 * The scheme also scopes VS Code's `editor/title` and `commandPalette` menu
 * `when` clauses (`isInDiffEditor && resourceScheme == tauren-review`) so the
 * Accept, Reject, Steer, and Auto-Approve actions appear only on Tauren review
 * diff tabs.
 *
 * Each review document uses the URI layout:
 * `tauren-review://<before|after>/<reviewId>/<normalizedPath>`
 *
 * Keeping the original file's path and extension at the end lets VS Code detect
 * the language and apply normal syntax highlighting, while the leading
 * `<reviewId>` segment lets `ChangeReviewController` map active or closed diff
 * tabs back to the corresponding pending review request.
 */
export const changeReviewScheme = 'tauren-review';

/**
 * Minimal URI shape needed to inspect a review URI without importing the
 * `vscode` runtime module, allowing controller logic and unit tests to run
 * outside the VS Code Extension Host.
 */
export interface ChangeReviewUriLike {
  scheme: string;
  authority: string;
  path: string;
  toString(): string;
}

/**
 * Extract the `<reviewId>` from a `tauren-review:` URI so toolbar commands and
 * tab-close listeners can identify which pending review a VS Code diff tab
 * belongs to. Returns undefined for any URI outside this scheme or layout.
 */
export function getChangeReviewIdFromUri(uri: ChangeReviewUriLike | undefined): string | undefined {
  if (!uri || uri.scheme !== changeReviewScheme) {
    return undefined;
  }

  if (uri.authority !== 'before' && uri.authority !== 'after') {
    return undefined;
  }

  const segments = uri.path.replace(/^\/+/, '').split('/').filter(Boolean);
  return segments.length >= 2 ? segments[0] : undefined;
}
