import * as assert from 'assert';
import {
  areAllVisibleDeletableSessionsChecked,
  canSelectSessionForDeletion,
  getOrderedCheckedSessionPaths,
  getVisibleDeletableSessionPaths,
  pruneCheckedSessionPaths,
  selectVisibleSessionPaths,
  toggleCheckedSessionPath
} from '../../webview/sessions/sessionSelection';
import type { SessionItem } from '../../webview/types';

function makeSession(overrides: Partial<SessionItem> & { path: string }): SessionItem {
  return {
    id: overrides.path,
    cwd: '/workspace',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:01:00.000Z',
    messageCount: 1,
    firstMessage: overrides.path,
    depth: 0,
    isLast: false,
    ancestorContinues: [],
    current: false,
    ...overrides
  };
}

suite('Webview session selection', () => {
  test('allows selecting idle sessions and blocks running or busy sessions', () => {
    assert.strictEqual(canSelectSessionForDeletion(makeSession({ path: '/a.jsonl' }), false), true);
    assert.strictEqual(canSelectSessionForDeletion(makeSession({ path: '/a.jsonl', current: true }), false), true);
    assert.strictEqual(canSelectSessionForDeletion(makeSession({ path: '/a.jsonl', current: true }), true), false);
    assert.strictEqual(canSelectSessionForDeletion(makeSession({ path: '/a.jsonl', liveStatus: 'running' }), false), false);
    assert.strictEqual(canSelectSessionForDeletion(makeSession({ path: '' }), false), false);
  });

  test('toggles checked state only for deletable sessions', () => {
    const idle = makeSession({ path: '/idle.jsonl' });
    const running = makeSession({ path: '/running.jsonl', liveStatus: 'running' });

    const first = toggleCheckedSessionPath(new Set(), idle, false);
    assert.deepStrictEqual([...first], ['/idle.jsonl']);

    const ignored = toggleCheckedSessionPath(first, running, false);
    assert.deepStrictEqual([...ignored], ['/idle.jsonl']);

    const cleared = toggleCheckedSessionPath(ignored, idle, false);
    assert.deepStrictEqual([...cleared], []);
  });

  test('prunes missing or newly busy sessions while preserving selection during initial refresh', () => {
    const initial = new Set(['/one.jsonl', '/two.jsonl', '/three.jsonl']);

    const duringEmptyRefresh = pruneCheckedSessionPaths(initial, [], { busy: false, sessionsRefreshing: true });
    assert.deepStrictEqual([...duringEmptyRefresh], ['/one.jsonl', '/two.jsonl', '/three.jsonl']);

    const afterRefresh = pruneCheckedSessionPaths(
      initial,
      [
        makeSession({ path: '/one.jsonl' }),
        makeSession({ path: '/two.jsonl', liveStatus: 'running' })
      ],
      { busy: false, sessionsRefreshing: false }
    );
    assert.deepStrictEqual([...afterRefresh], ['/one.jsonl']);

    const afterDeleteAll = pruneCheckedSessionPaths(initial, [], { busy: false, sessionsRefreshing: false });
    assert.deepStrictEqual([...afterDeleteAll], []);
  });

  test('selects visible deletable sessions while preserving off-filter selections', () => {
    const sessions = [
      makeSession({ path: '/hidden-checked.jsonl' }),
      makeSession({ path: '/visible-1.jsonl' }),
      makeSession({ path: '/visible-running.jsonl', liveStatus: 'running' }),
      makeSession({ path: '/visible-2.jsonl' })
    ];
    const visibleIndexes = [1, 2, 3];
    const initial = new Set(['/hidden-checked.jsonl']);

    assert.deepStrictEqual(getVisibleDeletableSessionPaths(sessions, visibleIndexes, false), [
      '/visible-1.jsonl',
      '/visible-2.jsonl'
    ]);
    assert.strictEqual(areAllVisibleDeletableSessionsChecked(initial, sessions, visibleIndexes, false), false);

    const selected = selectVisibleSessionPaths(initial, sessions, visibleIndexes, false);
    assert.deepStrictEqual([...selected], [
      '/hidden-checked.jsonl',
      '/visible-1.jsonl',
      '/visible-2.jsonl'
    ]);
    assert.strictEqual(areAllVisibleDeletableSessionsChecked(selected, sessions, visibleIndexes, false), true);
  });

  test('orders checked paths to match session list order', () => {
    const sessions = [
      makeSession({ path: '/first.jsonl' }),
      makeSession({ path: '/second.jsonl' }),
      makeSession({ path: '/third.jsonl' })
    ];
    const checkedOutOfOrder = new Set(['/third.jsonl', '/first.jsonl']);

    assert.deepStrictEqual(getOrderedCheckedSessionPaths(checkedOutOfOrder, sessions, false), [
      '/first.jsonl',
      '/third.jsonl'
    ]);
  });
});
