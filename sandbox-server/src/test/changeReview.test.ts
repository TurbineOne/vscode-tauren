import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  ErrorCodes,
  Notifications,
  Requests,
  ReviewRequests,
  type ChangeReviewDecision,
  type ChangeReviewRequest,
  type DiagnosticParams
} from '@tauren/shared/sbx/protocol';
import { bounded, completeTurn, createServerFixture, serverTestOptions } from './serverFixture.js';

test('initialize advertises review.change and validates perChangeReviewEnabled', serverTestOptions, async () => {
  const fixture = await createServerFixture();
  try {
    const server = fixture.launch();
    await assert.rejects(
      server.request(server.client.sendRequest(Requests.initialize, {
        ...fixture.params,
        perChangeReviewEnabled: 'yes' as unknown as boolean
      })),
      (error: { code?: number }) => error.code === ErrorCodes.InvalidParams
    );

    const initialized = await server.request(
      server.client.sendRequest(Requests.initialize, { ...fixture.params, perChangeReviewEnabled: true })
    );
    assert.ok(initialized.capabilities.includes(ReviewRequests.change.method));
    await server.shutdown();
  } finally {
    await fixture.close();
  }
});

test('review.change approves write and steers edit over JSON-RPC', serverTestOptions, async () => {
  const fixture = await createServerFixture();
  try {
    const server = fixture.launch();
    const seen: ChangeReviewRequest[] = [];
    server.client.onRequest(ReviewRequests.change, (request): ChangeReviewDecision => {
      seen.push(request);
      if (request.toolName === 'write') {
        return { action: 'approve' };
      }
      return { action: 'steer', feedback: 'Leave roundtrip.txt as before' };
    });

    await server.request(
      server.client.sendRequest(Requests.initialize, { ...fixture.params, perChangeReviewEnabled: true })
    );

    const history = await completeTurn(server, 'tools-roundtrip');
    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.toolName, 'write');
    assert.equal(seen[0]?.isNewFile, true);
    assert.equal(seen[0]?.afterText, 'before\n');
    assert.equal(seen[1]?.toolName, 'edit');
    assert.equal(seen[1]?.beforeText, 'before\n');
    assert.equal(seen[1]?.afterText, 'after\n');

    // Write was approved, edit was steered/blocked -> file retains 'before\n'.
    assert.equal(await readFile(path.join(fixture.workspace, 'roundtrip.txt'), 'utf8'), 'before\n');
    assert.match(JSON.stringify(history.messages), /Leave roundtrip\.txt as before/);
    await server.shutdown();
  } finally {
    await fixture.close();
  }
});

test('review.setConfig toggles review live and validates malformed config/decisions', serverTestOptions, async () => {
  const fixture = await createServerFixture();
  try {
    const server = fixture.launch();
    const diagnostics: DiagnosticParams[] = [];
    server.client.onNotification(Notifications.diagnostic, (diag) => diagnostics.push(diag));

    let seenCount = 0;
    let returnMalformedDecision = false;
    server.client.onRequest(ReviewRequests.change, () => {
      seenCount += 1;
      if (returnMalformedDecision) {
        return { action: 'unknown-action' } as unknown as ChangeReviewDecision;
      }
      return { action: 'reject', reason: 'Blocked after live toggle' };
    });

    // Start disabled: tools-roundtrip runs without invoking review.change.
    await server.request(
      server.client.sendRequest(Requests.initialize, { ...fixture.params, perChangeReviewEnabled: false })
    );
    await completeTurn(server, 'tools-roundtrip');
    assert.equal(seenCount, 0);
    assert.equal(await readFile(path.join(fixture.workspace, 'roundtrip.txt'), 'utf8'), 'after\n');

    // Malformed notification logs a warning diagnostic without crashing or enabling review.
    await server.client.sendNotification(Notifications.setReviewConfig, { enabled: 'bad' as unknown as boolean });
    await completeTurn(server, 'echo-check');
    assert.ok(diagnostics.some((entry) => entry.message.includes('Invalid change review config')));

    // Enable live via notification -> next tools-roundtrip invokes review.change and blocks write.
    await server.client.sendNotification(Notifications.setReviewConfig, { enabled: true });
    await completeTurn(server, 'tools-roundtrip');
    assert.ok(seenCount >= 1);
    assert.equal(await readFile(path.join(fixture.workspace, 'roundtrip.txt'), 'utf8'), 'after\n');

    // Malformed host decision safely cancels/blocks instead of mutating disk.
    returnMalformedDecision = true;
    await completeTurn(server, 'tools-roundtrip');
    assert.equal(await readFile(path.join(fixture.workspace, 'roundtrip.txt'), 'utf8'), 'after\n');
    assert.ok(diagnostics.some((entry) => entry.message.includes('Invalid change review decision')));

    await server.shutdown();
  } finally {
    await fixture.close();
  }
});

test('chat.abort cancels a pending review.change host token without writing and allows recovery', serverTestOptions, async () => {
  const fixture = await createServerFixture();
  try {
    const server = fixture.launch();
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    let hostTokenCancelled = false;

    server.client.onRequest(ReviewRequests.change, (_request, token) =>
      new Promise<ChangeReviewDecision>((resolve) => {
        resolveEntered();
        token.onCancellationRequested(() => {
          hostTokenCancelled = true;
          resolve({ action: 'cancel' });
        });
      })
    );

    await server.request(
      server.client.sendRequest(Requests.initialize, { ...fixture.params, perChangeReviewEnabled: true })
    );

    const start = server.events.length;
    assert.equal(await server.request(server.client.sendRequest(Requests.prompt, { message: 'tools-roundtrip' })), null);
    await bounded(entered, 'review.change entered');

    assert.equal(await server.request(server.client.sendRequest(Requests.abort, null)), null);
    await server.waitForEvent((event) => server.events.indexOf(event) >= start && event.event.type === 'agent_settled');
    assert.equal(hostTokenCancelled, true);
    await assert.rejects(() => access(path.join(fixture.workspace, 'roundtrip.txt')));

    // Subsequent prompt recovers cleanly.
    const recovery = await completeTurn(server, 'recovered');
    assert.match(JSON.stringify(recovery.messages), /fixture: recovered/);
    await server.shutdown();
  } finally {
    await fixture.close();
  }
});

test('EOF during a pending review.change tears down cleanly without writing', serverTestOptions, async () => {
  const fixture = await createServerFixture();
  try {
    const server = fixture.launch();
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });

    server.client.onRequest(ReviewRequests.change, () =>
      new Promise<ChangeReviewDecision>(() => {
        resolveEntered();
      })
    );

    await server.request(
      server.client.sendRequest(Requests.initialize, { ...fixture.params, perChangeReviewEnabled: true })
    );
    assert.equal(await server.request(server.client.sendRequest(Requests.prompt, { message: 'tools-roundtrip' })), null);
    await bounded(entered, 'review.change entered before EOF');

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      server.child.once('close', (code, signal) => resolve({ code, signal }));
    });
    server.child.stdin.end();

    const status = await bounded(exited, 'server exit on EOF during review');
    assert.equal(status.code, 0);
    await assert.rejects(() => access(path.join(fixture.workspace, 'roundtrip.txt')));
  } finally {
    await fixture.close();
  }
});
