import type { SessionItem } from '../types';

export function canSelectSessionForDeletion(
  session: Pick<SessionItem, 'path' | 'liveStatus' | 'current'>,
  busy: boolean
): boolean {
  return Boolean(session.path) && session.liveStatus !== 'running' && !(session.current && busy);
}

export function pruneCheckedSessionPaths(
  checkedPaths: ReadonlySet<string>,
  sessions: readonly SessionItem[],
  options: { busy: boolean; sessionsRefreshing?: boolean }
): Set<string> {
  if (checkedPaths.size === 0) {
    return new Set();
  }

  if (options.sessionsRefreshing && sessions.length === 0) {
    return new Set(checkedPaths);
  }

  const validPaths = new Set<string>();

  for (const session of sessions) {
    if (canSelectSessionForDeletion(session, options.busy) && checkedPaths.has(session.path)) {
      validPaths.add(session.path);
    }
  }

  return validPaths;
}

export function toggleCheckedSessionPath(
  checkedPaths: ReadonlySet<string>,
  session: SessionItem | undefined,
  busy: boolean
): Set<string> {
  const next = new Set(checkedPaths);

  if (!session || !canSelectSessionForDeletion(session, busy)) {
    return next;
  }

  if (next.has(session.path)) {
    next.delete(session.path);
  } else {
    next.add(session.path);
  }

  return next;
}

export function getVisibleDeletableSessionPaths(
  sessions: readonly SessionItem[],
  visibleIndexes: readonly number[],
  busy: boolean
): string[] {
  const paths: string[] = [];

  for (const index of visibleIndexes) {
    const session = sessions[index];

    if (session && canSelectSessionForDeletion(session, busy)) {
      paths.push(session.path);
    }
  }

  return paths;
}

export function selectVisibleSessionPaths(
  checkedPaths: ReadonlySet<string>,
  sessions: readonly SessionItem[],
  visibleIndexes: readonly number[],
  busy: boolean
): Set<string> {
  const next = new Set(checkedPaths);

  for (const path of getVisibleDeletableSessionPaths(sessions, visibleIndexes, busy)) {
    next.add(path);
  }

  return next;
}

export function areAllVisibleDeletableSessionsChecked(
  checkedPaths: ReadonlySet<string>,
  sessions: readonly SessionItem[],
  visibleIndexes: readonly number[],
  busy: boolean
): boolean {
  const visibleDeletablePaths = getVisibleDeletableSessionPaths(sessions, visibleIndexes, busy);
  return visibleDeletablePaths.length > 0 && visibleDeletablePaths.every((path) => checkedPaths.has(path));
}

export function getOrderedCheckedSessionPaths(
  checkedPaths: ReadonlySet<string>,
  sessions: readonly SessionItem[],
  busy: boolean
): string[] {
  if (checkedPaths.size === 0) {
    return [];
  }

  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const session of sessions) {
    if (canSelectSessionForDeletion(session, busy) && checkedPaths.has(session.path) && !seen.has(session.path)) {
      seen.add(session.path);
      ordered.push(session.path);
    }
  }

  return ordered;
}
