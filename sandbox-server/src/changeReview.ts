import {
  CancellationTokenSource,
  Notifications,
  ReviewRequests,
  type ChangeReviewDecision,
  type ChangeReviewRequest,
  type Disposable,
  type MessageConnection
} from '@tauren/shared/sbx/protocol';

function isPlainRecord(value: unknown, allowedKeys: string[]): value is Record<string, unknown> {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function decodeDecision(value: unknown): ChangeReviewDecision | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const action = record.action;

  if (action === 'approve' || action === 'approve_session') {
    return isPlainRecord(record, ['action']) ? { action } : undefined;
  }

  if (action === 'reject' || action === 'cancel') {
    if (!isPlainRecord(record, ['action', 'reason'])) {
      return undefined;
    }
    if (record.reason !== undefined && typeof record.reason !== 'string') {
      return undefined;
    }
    return record.reason === undefined ? { action } : { action, reason: record.reason };
  }

  if (action === 'steer') {
    if (!isPlainRecord(record, ['action', 'feedback']) || typeof record.feedback !== 'string') {
      return undefined;
    }
    return { action: 'steer', feedback: record.feedback };
  }

  return undefined;
}

/**
 * Bridges per-change diff review from the sandbox Pi runtime to the VS Code
 * host over JSON-RPC. Cancelling or disposing the bridge sends `$/cancelRequest`
 * to the host so open diff tabs close without approving the pending edit.
 */
export class RemoteChangeReview {
  public readonly capabilityMethods: string[] = [ReviewRequests.change.method];
  private readonly registrations: Disposable[] = [];
  private readonly pending = new Set<() => void>();
  private enabled = false;
  private configUpdatedByNotification = false;
  private disposed = false;

  public constructor(
    private readonly connection: MessageConnection,
    private readonly diagnostic: (message: string) => void
  ) {
    this.registrations.push(
      connection.onNotification(Notifications.setReviewConfig, (input) => {
        if (!isPlainRecord(input, ['enabled']) || typeof input.enabled !== 'boolean') {
          this.diagnostic('Invalid change review config notification');
          return;
        }
        this.configUpdatedByNotification = true;
        this.enabled = input.enabled;
      }),
      connection.onClose(() => this.dispose()),
      connection.onDispose(() => this.dispose())
    );
  }

  public applyInitialEnabled(initialEnabled: boolean): void {
    if (!this.configUpdatedByNotification) {
      this.enabled = initialEnabled;
    }
  }

  public isEnabled(): boolean {
    return !this.disposed && this.enabled;
  }

  public reviewChange(request: ChangeReviewRequest, signal: AbortSignal): Promise<ChangeReviewDecision> {
    if (this.disposed || signal.aborted) {
      return Promise.resolve({ action: 'cancel', reason: `Cancelled diff review for ${request.path}.` });
    }

    return new Promise<ChangeReviewDecision>((resolve) => {
      const source = new CancellationTokenSource();
      let settled = false;

      const finish = (decision: ChangeReviewDecision, cancelRemote: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        this.pending.delete(abort);
        signal.removeEventListener('abort', abort);
        if (cancelRemote) {
          source.cancel();
        }
        source.dispose();
        resolve(decision);
      };

      const abort = () => {
        finish({ action: 'cancel', reason: `Cancelled diff review for ${request.path}.` }, true);
      };

      this.pending.add(abort);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted || this.disposed) {
        abort();
        return;
      }

      try {
        void this.connection.sendRequest(ReviewRequests.change, request, source.token).then(
          (value) => {
            if (settled) {
              return;
            }
            const decoded = decodeDecision(value);
            if (!decoded) {
              this.diagnostic('Invalid change review decision from host');
              finish({ action: 'cancel', reason: `Invalid diff review response for ${request.path}.` }, false);
              return;
            }
            finish(decoded, false);
          },
          () => {
            if (!settled) {
              this.diagnostic('Change review host request failed');
              finish({ action: 'cancel', reason: `Diff review interrupted for ${request.path}.` }, false);
            }
          }
        );
      } catch {
        this.diagnostic('Change review host request failed');
        abort();
      }
    });
  }

  public cancelReviews(): void {
    for (const abort of [...this.pending]) {
      abort();
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelReviews();
    for (const registration of this.registrations.splice(0)) {
      registration.dispose();
    }
  }
}
