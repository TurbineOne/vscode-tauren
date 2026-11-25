import * as assert from 'assert';
import type { ChangeReviewRequest } from '@tauren/shared/review/types';
import { ChangeReviewController, type ChangeReviewHost, type DisposableLike } from '../../diff/changeReviewController';
import { changeReviewScheme, getChangeReviewIdFromUri, type ChangeReviewUriLike } from '../../diff/changeReviewUri';

function makeUri(scheme: string, authority: string, uriPath: string): ChangeReviewUriLike {
  return {
    scheme,
    authority,
    path: uriPath,
    toString: () => `${scheme}://${authority}${uriPath}`
  };
}

function makeRequest(id: string, filePath = `src/${id}.ts`): ChangeReviewRequest {
  return {
    toolCallId: `call-${id}`,
    toolName: 'edit',
    path: filePath,
    absolutePath: `/workspace/${filePath}`,
    beforeText: `const ${id} = 1;\n`,
    afterText: `const ${id} = 2;\n`,
    isNewFile: false
  };
}

class FakeChangeReviewHost implements ChangeReviewHost {
  public readonly opened: Array<{ reviewId: string; request: ChangeReviewRequest; beforeUri: ChangeReviewUriLike; afterUri: ChangeReviewUriLike }> = [];
  public readonly closed: Array<{ beforeUri: ChangeReviewUriLike; afterUri: ChangeReviewUriLike }> = [];
  public readonly deletedContent: Array<{ beforeUri: ChangeReviewUriLike; afterUri: ChangeReviewUriLike }> = [];
  public readonly backgroundNotifications: Array<{ sessionId: string; request: ChangeReviewRequest }> = [];
  public activeReviewId: string | undefined;
  public steerPromptResult: string | undefined;
  private readonly closeListeners = new Set<(reviewId: string) => void>();

  public async openDiff(reviewId: string, request: ChangeReviewRequest) {
    const beforeUri = makeUri(changeReviewScheme, 'before', `/${reviewId}/${request.path}`);
    const afterUri = makeUri(changeReviewScheme, 'after', `/${reviewId}/${request.path}`);
    this.opened.push({ reviewId, request, beforeUri, afterUri });
    this.activeReviewId = reviewId;
    return { beforeUri, afterUri };
  }

  public async closeDiff(beforeUri: ChangeReviewUriLike, afterUri: ChangeReviewUriLike): Promise<void> {
    this.closed.push({ beforeUri, afterUri });
    const reviewId = getChangeReviewIdFromUri(afterUri);
    if (reviewId) {
      // Simulate VS Code emitting onDidChangeTabs when a tab closes programmatically.
      this.emitTabClosed(reviewId);
    }
    this.deleteReviewContent(beforeUri, afterUri);
  }

  public deleteReviewContent(beforeUri: ChangeReviewUriLike, afterUri: ChangeReviewUriLike): void {
    this.deletedContent.push({ beforeUri, afterUri });
  }

  public onDidCloseDiffTab(listener: (reviewId: string) => void): DisposableLike {
    this.closeListeners.add(listener);
    return {
      dispose: () => {
        this.closeListeners.delete(listener);
      }
    };
  }

  public async promptSteerFeedback(): Promise<string | undefined> {
    return this.steerPromptResult;
  }

  public getActiveReviewId(): string | undefined {
    return this.activeReviewId;
  }

  public notifyBackgroundReview(sessionId: string, request: ChangeReviewRequest): void {
    this.backgroundNotifications.push({ sessionId, request });
  }

  public emitTabClosed(reviewId: string): void {
    for (const listener of this.closeListeners) {
      listener(reviewId);
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

suite('ChangeReviewController', () => {
  test('parses review IDs from tauren-review URIs only', () => {
    const beforeUri = makeUri(changeReviewScheme, 'before', '/42/src/app.ts');
    const afterUri = makeUri(changeReviewScheme, 'after', '/42/src/app.ts');
    const otherUri = makeUri('file', '', '/42/src/app.ts');

    assert.strictEqual(getChangeReviewIdFromUri(beforeUri), '42');
    assert.strictEqual(getChangeReviewIdFromUri(afterUri), '42');
    assert.strictEqual(getChangeReviewIdFromUri(otherUri), undefined);
    assert.strictEqual(getChangeReviewIdFromUri(undefined), undefined);
  });

  test('queues reviews per session in FIFO order and resolves accept, reject, and steer', async () => {
    const host = new FakeChangeReviewHost();
    const controller = new ChangeReviewController({ host, activeSessionId: 'session-1' });
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const ac3 = new AbortController();

    const p1 = controller.reviewChange('session-1', makeRequest('first'), ac1.signal);
    const p2 = controller.reviewChange('session-1', makeRequest('second'), ac2.signal);
    const p3 = controller.reviewChange('session-1', makeRequest('third'), ac3.signal);
    await flushMicrotasks();

    // Only the first review should open initially.
    assert.strictEqual(host.opened.length, 1);
    assert.strictEqual(host.opened[0]?.request.path, 'src/first.ts');

    // Accept the first review -> closes tab and opens the second.
    await controller.accept();
    assert.deepStrictEqual(await p1, { action: 'approve' });
    assert.strictEqual(host.closed.length, 1);
    await flushMicrotasks();
    assert.strictEqual(host.opened.length, 2);
    assert.strictEqual(host.opened[1]?.request.path, 'src/second.ts');

    // Reject the second review -> closes tab and opens the third.
    await controller.reject(undefined, 'Do not change second');
    assert.deepStrictEqual(await p2, { action: 'reject', reason: 'Do not change second' });
    assert.strictEqual(host.closed.length, 2);
    await flushMicrotasks();
    assert.strictEqual(host.opened.length, 3);
    assert.strictEqual(host.opened[2]?.request.path, 'src/third.ts');

    // Cancelling the steer input box leaves the third review open and pending.
    host.steerPromptResult = undefined;
    await controller.steer();
    assert.strictEqual(controller.hasPendingReview('session-1'), true);
    assert.strictEqual(host.closed.length, 2);

    // Submitting steer feedback resolves with steer and closes the tab.
    host.steerPromptResult = '  Use a const helper instead  ';
    await controller.steer();
    assert.deepStrictEqual(await p3, { action: 'steer', feedback: 'Use a const helper instead' });
    assert.strictEqual(host.closed.length, 3);
    assert.strictEqual(controller.hasPendingReview('session-1'), false);

    controller.dispose();
  });

  test('treats manual diff tab close as approve and advances queue', async () => {
    const host = new FakeChangeReviewHost();
    const controller = new ChangeReviewController({ host, activeSessionId: 'session-1' });
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    const p1 = controller.reviewChange('session-1', makeRequest('one'), ac1.signal);
    const p2 = controller.reviewChange('session-1', makeRequest('two'), ac2.signal);
    await flushMicrotasks();

    assert.strictEqual(host.opened.length, 1);
    const firstReviewId = host.opened[0]!.reviewId;

    // User manually closes the diff tab.
    host.emitTabClosed(firstReviewId);
    assert.deepStrictEqual(await p1, { action: 'approve' });
    assert.strictEqual(host.closed.length, 0);
    assert.strictEqual(host.deletedContent.length, 1);

    await flushMicrotasks();
    assert.strictEqual(host.opened.length, 2);
    assert.strictEqual(host.opened[1]?.request.path, 'src/two.ts');

    await controller.accept();
    assert.deepStrictEqual(await p2, { action: 'approve' });
    controller.dispose();
  });

  test('cancels pending review on AbortSignal without treating programmatic close as approval', async () => {
    const host = new FakeChangeReviewHost();
    const controller = new ChangeReviewController({ host, activeSessionId: 'session-1' });
    const ac = new AbortController();

    const pending = controller.reviewChange('session-1', makeRequest('aborted'), ac.signal);
    await flushMicrotasks();
    assert.strictEqual(host.opened.length, 1);

    ac.abort();
    const decision = await pending;
    assert.strictEqual(decision.action, 'cancel');
    assert.strictEqual(host.closed.length, 1);
    assert.strictEqual(controller.hasPendingReview('session-1'), false);

    controller.dispose();
  });

  test('approveSession approves current review and remaining queued reviews in the session', async () => {
    const host = new FakeChangeReviewHost();
    const controller = new ChangeReviewController({ host, activeSessionId: 'session-1' });
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    const p1 = controller.reviewChange('session-1', makeRequest('first'), ac1.signal);
    const p2 = controller.reviewChange('session-1', makeRequest('second'), ac2.signal);
    await flushMicrotasks();

    await controller.approveSession();
    assert.deepStrictEqual(await p1, { action: 'approve_session' });
    assert.deepStrictEqual(await p2, { action: 'approve' });
    assert.strictEqual(host.opened.length, 1);
    assert.strictEqual(controller.hasPendingReview('session-1'), false);

    controller.dispose();
  });

  test('defers background session reviews until the session becomes active', async () => {
    const host = new FakeChangeReviewHost();
    const controller = new ChangeReviewController({ host, activeSessionId: 'session-active' });
    const ac = new AbortController();

    const pending = controller.reviewChange('session-bg', makeRequest('bg'), ac.signal);
    await flushMicrotasks();

    assert.strictEqual(host.opened.length, 0);
    assert.strictEqual(host.backgroundNotifications.length, 1);
    assert.strictEqual(host.backgroundNotifications[0]?.sessionId, 'session-bg');

    controller.setActiveSession('session-bg');
    await flushMicrotasks();

    assert.strictEqual(host.opened.length, 1);
    assert.strictEqual(host.opened[0]?.request.path, 'src/bg.ts');

    await controller.accept();
    assert.deepStrictEqual(await pending, { action: 'approve' });
    controller.dispose();
  });
});
