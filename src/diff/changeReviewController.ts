/**
 * Per-change diff review separates workflow coordination from VS Code UI calls
 * so the state machine can be unit-tested without launching VS Code.
 *
 * - `ChangeReviewController` (this file) owns the review state machine:
 *   per-session FIFO queueing, deferring background sessions until they become
 *   active, treating manual tab closes as approval, and cancelling pending
 *   reviews on abort or disposal. It has no runtime dependency on `vscode`.
 * - `ChangeReviewHost` (defined below) is the UI boundary the controller calls
 *   when it needs to open or close a diff tab, observe user tab closes, prompt
 *   for steering feedback, or inspect the active tab. In production, the host
 *   is VS Code; in tests, it is a lightweight in-memory fake.
 * - `ChangeReviewViewer` and `createVscodeChangeReviewHost()` (in
 *   `changeReviewViewer.ts`) provide the VS Code implementation of that host
 *   boundary by serving virtual `tauren-review:` documents and bridging
 *   `vscode.diff`, `vscode.window.tabGroups`, and `vscode.window.showInputBox`.
 *
 * `TaurenChatViewProvider` constructs the production controller by passing
 * `createVscodeChangeReviewHost()` into `new ChangeReviewController({ host })`.
 */

import type { ChangeReviewDecision, ChangeReviewRequest } from '@tauren/shared/review/types';
import { getChangeReviewIdFromUri, type ChangeReviewUriLike } from './changeReviewUri';

export interface DisposableLike {
  dispose(): void;
}

export interface OpenedChangeReviewDiff {
  beforeUri: ChangeReviewUriLike;
  afterUri: ChangeReviewUriLike;
}

export interface ChangeReviewHost {
  openDiff(reviewId: string, request: ChangeReviewRequest): Promise<OpenedChangeReviewDiff>;
  closeDiff(beforeUri: ChangeReviewUriLike, afterUri: ChangeReviewUriLike): Promise<void>;
  deleteReviewContent(beforeUri: ChangeReviewUriLike, afterUri: ChangeReviewUriLike): void;
  onDidCloseDiffTab(listener: (reviewId: string) => void): DisposableLike;
  promptSteerFeedback(request: ChangeReviewRequest): Promise<string | undefined>;
  getActiveReviewId(): string | undefined;
  notifyBackgroundReview?(sessionId: string, request: ChangeReviewRequest): void;
  dispose?(): void;
}

export interface ChangeReviewControllerOptions {
  host: ChangeReviewHost;
  activeSessionId?: string;
}

type PendingReviewState = 'queued' | 'opening' | 'open' | 'settled';

interface PendingReviewEntry {
  reviewId: string;
  sessionId: string;
  request: ChangeReviewRequest;
  signal: AbortSignal;
  resolve: (decision: ChangeReviewDecision) => void;
  state: PendingReviewState;
  programmaticClose: boolean;
  beforeUri?: ChangeReviewUriLike;
  afterUri?: ChangeReviewUriLike;
  onAbort?: () => void;
}

/**
 * Coordinates per-change diff review across sessions: serializes requests in
 * FIFO order per session, defers background sessions until they become active,
 * treats manual diff-tab closes as approval, and cancels pending reviews on
 * explicit abort or disposal without writing to disk.
 */
export class ChangeReviewController implements DisposableLike {
  private readonly host: ChangeReviewHost;
  private readonly sessionQueues = new Map<string, PendingReviewEntry[]>();
  private readonly openBySession = new Map<string, PendingReviewEntry>();
  private readonly openById = new Map<string, PendingReviewEntry>();
  private readonly notifiedBackgroundSessions = new Set<string>();
  private readonly tabCloseSubscription: DisposableLike;
  private activeSessionId: string | undefined;
  private reviewSequence = 0;
  private disposed = false;

  public constructor(options: ChangeReviewControllerOptions) {
    this.host = options.host;
    this.activeSessionId = options.activeSessionId;
    this.tabCloseSubscription = this.host.onDidCloseDiffTab((reviewId) => {
      this.handleUserTabClose(reviewId);
    });
  }

  /**
   * Cancel every open and queued review across all sessions, unsubscribe from
   * tab-close events, and dispose the underlying host resources.
   */
  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.tabCloseSubscription.dispose();

    const allSessions = new Set<string>([
      ...this.sessionQueues.keys(),
      ...this.openBySession.keys()
    ]);

    for (const sessionId of allSessions) {
      void this.cancelSession(sessionId, 'Diff review controller disposed.');
    }

    this.notifiedBackgroundSessions.clear();
    this.host.dispose?.();
  }

  /**
   * Update which session is currently visible in the Chat Lane. If the newly
   * active session already has deferred review requests waiting, open the
   * first queued diff immediately.
   */
  public setActiveSession(sessionId: string | undefined): void {
    this.activeSessionId = sessionId;

    if (!sessionId) {
      return;
    }

    this.notifiedBackgroundSessions.delete(sessionId);
    this.pumpSessionQueue(sessionId);
  }

  /**
   * Return whether a specific session (or any session when omitted) currently
   * has an open or queued change review.
   */
  public hasPendingReview(sessionId?: string): boolean {
    if (sessionId !== undefined) {
      return this.openBySession.has(sessionId) || (this.sessionQueues.get(sessionId)?.length ?? 0) > 0;
    }

    return this.openById.size > 0 || Array.from(this.sessionQueues.values()).some((queue) => queue.length > 0);
  }

  /**
   * Enqueue a proposed file change for review and resolve once the user
   * accepts, rejects, steers, closes the diff tab, or aborts via `signal`.
   * Requests for the same session open one at a time in FIFO order, and
   * requests for inactive background sessions wait until that session becomes
   * active.
   */
  public reviewChange(
    sessionId: string,
    request: ChangeReviewRequest,
    signal: AbortSignal
  ): Promise<ChangeReviewDecision> {
    if (this.disposed || signal.aborted) {
      return Promise.resolve({ action: 'cancel', reason: `Cancelled diff review for ${request.path}.` });
    }

    const reviewId = String(++this.reviewSequence);

    return new Promise<ChangeReviewDecision>((resolve) => {
      const entry: PendingReviewEntry = {
        reviewId,
        sessionId,
        request,
        signal,
        resolve,
        state: 'queued',
        programmaticClose: false
      };

      const onAbort = () => {
        void this.settleEntry(entry, { action: 'cancel', reason: `Cancelled diff review for ${request.path}.` }, true);
      };
      entry.onAbort = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });

      const queue = this.sessionQueues.get(sessionId) ?? [];
      queue.push(entry);
      this.sessionQueues.set(sessionId, queue);

      this.pumpSessionQueue(sessionId);
    });
  }

  /**
   * Approve the targeted (or currently active) open diff review, close its
   * diff tab, and advance the session's queue to the next pending change.
   */
  public async accept(targetUri?: ChangeReviewUriLike): Promise<void> {
    const entry = this.resolveTargetEntry(targetUri);
    if (!entry) {
      return;
    }

    await this.settleEntry(entry, { action: 'approve' }, true);
  }

  /**
   * Approve the targeted open diff review and enable session-scoped
   * auto-approve for the rest of that session. Any additional changes already
   * queued for the same session are approved immediately without opening more
   * diff tabs.
   */
  public async approveSession(targetUri?: ChangeReviewUriLike): Promise<void> {
    const entry = this.resolveTargetEntry(targetUri);
    if (!entry) {
      return;
    }

    const sessionId = entry.sessionId;

    // Drain any queued changes before settling the active entry so settling does
    // not pump and open another diff tab for the same session.
    const remaining = this.sessionQueues.get(sessionId);
    const queuedCopy = remaining ? remaining.splice(0, remaining.length) : [];
    this.sessionQueues.delete(sessionId);

    for (const queued of queuedCopy) {
      await this.settleEntry(queued, { action: 'approve' }, false);
    }

    await this.settleEntry(entry, { action: 'approve_session' }, true);
  }

  /**
   * Reject the targeted open diff review so the underlying tool call is
   * blocked without touching disk, then close its diff tab.
   */
  public async reject(targetUri?: ChangeReviewUriLike, reason?: string): Promise<void> {
    const entry = this.resolveTargetEntry(targetUri);
    if (!entry) {
      return;
    }

    await this.settleEntry(entry, reason ? { action: 'reject', reason } : { action: 'reject' }, true);
  }

  /**
   * Prompt the user for steering feedback on the targeted open diff review.
   * Submitting non-empty feedback blocks the edit, forwards the instructions
   * as a steer message, and closes the diff tab; dismissing the prompt leaves
   * the diff tab open and the review pending.
   */
  public async steer(targetUri?: ChangeReviewUriLike): Promise<void> {
    const entry = this.resolveTargetEntry(targetUri);
    if (!entry) {
      return;
    }

    const feedback = await this.host.promptSteerFeedback(entry.request);
    if (feedback === undefined) {
      // User dismissed the input box; leave the diff tab open and review pending.
      return;
    }

    const trimmed = feedback.trim();
    if (!trimmed) {
      return;
    }

    if (entry.state !== 'open') {
      return;
    }

    await this.settleEntry(entry, { action: 'steer', feedback: trimmed }, true);
  }

  /**
   * Cancel all queued and open reviews for a session (for example, on
   * generation abort, session disposal, or backend disconnect) and close any
   * open diff tab without triggering manual-close approval.
   */
  public async cancelSession(sessionId: string, reason?: string): Promise<void> {
    const cancelReason = reason ?? 'Cancelled diff review.';
    const queued = this.sessionQueues.get(sessionId);
    const queuedCopy = queued ? queued.splice(0, queued.length) : [];
    this.sessionQueues.delete(sessionId);
    this.notifiedBackgroundSessions.delete(sessionId);

    for (const entry of queuedCopy) {
      await this.settleEntry(entry, { action: 'cancel', reason: cancelReason }, false);
    }

    const openEntry = this.openBySession.get(sessionId);
    if (openEntry) {
      await this.settleEntry(openEntry, { action: 'cancel', reason: cancelReason }, true);
    }
  }

  private pumpSessionQueue(sessionId: string): void {
    if (this.disposed) {
      return;
    }

    if (this.openBySession.has(sessionId)) {
      return;
    }

    const queue = this.sessionQueues.get(sessionId);
    if (!queue || queue.length === 0) {
      return;
    }

    if (this.activeSessionId !== undefined && sessionId !== this.activeSessionId) {
      if (!this.notifiedBackgroundSessions.has(sessionId)) {
        this.notifiedBackgroundSessions.add(sessionId);
        this.host.notifyBackgroundReview?.(sessionId, queue[0]!.request);
      }
      return;
    }

    const next = queue.shift()!;
    if (queue.length === 0) {
      this.sessionQueues.delete(sessionId);
    }

    if (next.state !== 'queued' || next.signal.aborted) {
      this.pumpSessionQueue(sessionId);
      return;
    }

    next.state = 'opening';
    this.openBySession.set(sessionId, next);
    this.openById.set(next.reviewId, next);

    void this.host.openDiff(next.reviewId, next.request).then(
      async ({ beforeUri, afterUri }) => {
        next.beforeUri = beforeUri;
        next.afterUri = afterUri;

        if (next.state !== 'opening') {
          // Entry was cancelled or settled while the diff editor was opening.
          next.programmaticClose = true;
          await this.safeCloseDiff(beforeUri, afterUri);
          return;
        }

        next.state = 'open';
      },
      async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await this.settleEntry(
          next,
          { action: 'cancel', reason: `Could not open diff review for ${next.request.path}: ${message}` },
          false
        );
      }
    );
  }

  private handleUserTabClose(reviewId: string): void {
    const entry = this.openById.get(reviewId);
    if (!entry || entry.programmaticClose || entry.state === 'settled') {
      return;
    }

    // Closing a pending diff tab manually counts as approval.
    void this.settleEntry(entry, { action: 'approve' }, false);
  }

  private resolveTargetEntry(targetUri?: ChangeReviewUriLike): PendingReviewEntry | undefined {
    const fromUri = getChangeReviewIdFromUri(targetUri);
    if (fromUri) {
      const entry = this.openById.get(fromUri);
      if (entry && entry.state === 'open') {
        return entry;
      }
    }

    const fromActiveTab = this.host.getActiveReviewId();
    if (fromActiveTab) {
      const entry = this.openById.get(fromActiveTab);
      if (entry && entry.state === 'open') {
        return entry;
      }
    }

    if (this.activeSessionId) {
      const entry = this.openBySession.get(this.activeSessionId);
      if (entry && entry.state === 'open') {
        return entry;
      }
    }

    if (this.openById.size === 1) {
      const only = this.openById.values().next().value;
      if (only && only.state === 'open') {
        return only;
      }
    }

    return undefined;
  }

  private async settleEntry(
    entry: PendingReviewEntry,
    decision: ChangeReviewDecision,
    closeTab: boolean
  ): Promise<void> {
    if (entry.state === 'settled') {
      return;
    }

    entry.state = 'settled';
    entry.programmaticClose = true;

    if (entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
      entry.onAbort = undefined;
    }

    const queue = this.sessionQueues.get(entry.sessionId);
    if (queue) {
      const index = queue.indexOf(entry);
      if (index !== -1) {
        queue.splice(index, 1);
      }
      if (queue.length === 0) {
        this.sessionQueues.delete(entry.sessionId);
      }
    }

    if (this.openBySession.get(entry.sessionId) === entry) {
      this.openBySession.delete(entry.sessionId);
    }

    if (this.openById.get(entry.reviewId) === entry) {
      this.openById.delete(entry.reviewId);
    }

    entry.resolve(decision);

    if (entry.beforeUri && entry.afterUri) {
      if (closeTab) {
        await this.safeCloseDiff(entry.beforeUri, entry.afterUri);
      } else {
        this.host.deleteReviewContent(entry.beforeUri, entry.afterUri);
      }
    }

    if (!this.disposed) {
      this.pumpSessionQueue(entry.sessionId);
    }
  }

  private async safeCloseDiff(beforeUri: ChangeReviewUriLike, afterUri: ChangeReviewUriLike): Promise<void> {
    try {
      await this.host.closeDiff(beforeUri, afterUri);
    } catch {
      this.host.deleteReviewContent(beforeUri, afterUri);
    }
  }
}
