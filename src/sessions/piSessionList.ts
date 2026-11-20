import { constants, existsSync, type Stats } from 'fs';
import { lstat, open, readdir, readFile, realpath, stat, type FileHandle } from 'fs/promises';
import { homedir } from 'os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path';
import { parseJsonlRecords } from '@tauren/shared/sessions/jsonl';
import { readSessionJsonlHeader } from '../pi/sessionJsonl';
import { readSessionMetadataCache, writeSessionMetadataCache, type CachedSessionInfo } from './sessionMetadataCache';
import { readSessionSummary } from '@tauren/shared/sessions/sessionSummaryParser';
import type { ListPiSessionsOptions, PiSessionCandidate, RawSessionInfo, SessionListItem } from './types';
import { decorateSessionTree } from '@tauren/shared/sessions/sessionTree';
import { mapWithConcurrency } from '../shared/mapWithConcurrency';
import { isRecord } from '../shared/typeGuards';
export type { ListPiSessionsOptions, PiSessionCandidate, SessionListItem } from './types';

const piSessionDirEnvName = 'PI_CODING_AGENT_SESSION_DIR';
const maxConcurrentSessionFileReads = 8;
const sessionListProgressBatchSize = 50;
const maxSbxHeaderBytes = 64 * 1024;

export type SbxSessionScope = {
  /** Canonical absolute paths returned by the provider's SBX path resolver. */
  sbxSessionStore?: string;
  sbxWorkspace?: string;
};

type SbxSessionListOptions = SbxSessionScope & Pick<
  ListPiSessionsOptions, 'currentSessionFile' | 'onProgress' | 'onMetrics'
>;

type SbxSessionFile = SessionFileStats & {
  handle: FileHandle;
  workspace: string;
};

type SessionFileStats = {
  path: string;
  stats: Stats;
};

type SessionFileLoad = {
  file: SessionFileStats;
  stale?: CachedSessionInfo;
};

export async function listPiSessions(options: ListPiSessionsOptions = {}): Promise<SessionListItem[]> {
  const env = options.env ?? process.env;
  const sessionDir = options.sessionDir
    ?? await resolveConfiguredSessionDir(options.cwd, options.currentSessionFile, env);
  const sessions = sessionDir ? await listSessionsFromDir(sessionDir, options) : [];

  return decorateSessions(sessions, options.currentSessionFile);
}

export async function listPiSessionCandidates(options: ListPiSessionsOptions = {}): Promise<PiSessionCandidate[]> {
  const env = options.env ?? process.env;
  const sessionDir = options.sessionDir
    ?? await resolveConfiguredSessionDir(options.cwd, options.currentSessionFile, env);

  return sessionDir ? listSessionCandidatesFromDir(sessionDir) : [];
}

export async function listSbxSessions(options: SbxSessionListOptions): Promise<SessionListItem[]> {
  const { sessionFiles, openFile } = await resolveSbxSessionFiles(options);
  const entries = await mapWithConcurrency(sessionFiles, maxConcurrentSessionFileReads, async (path) => {
    const file = await openFile(path);
    if (!file) return undefined;

    try {
      const summary = await readSessionSummary(file.path, file.stats, streamSbxSession(file));
      if (!summary || !await matchesWorkspace(summary.cwd, file.workspace)) return undefined;
      return { session: markSessionMetadataReady({ ...summary, cwd: file.workspace }), bytes: file.stats.size };
    } catch {
      return undefined;
    } finally {
      await file.handle.close();
    }
  });
  const ready = entries.filter((entry) => entry !== undefined);
  const sessions = decorateSessions(ready.map(({ session }) => session), options.currentSessionFile);
  if (sessions.length) options.onProgress?.(sessions);
  options.onMetrics?.({
    sessionCount: sessions.length,
    totalBytes: ready.reduce((total, { bytes }) => total + bytes, 0),
    cacheHits: 0,
    cacheMisses: sessions.length
  });
  return sessions;
}

export async function discoverSbxSessionFiles(options: SbxSessionScope, explicitFiles?: string[]) {
  const { sessionFiles, openFile } = await resolveSbxSessionFiles(options, explicitFiles);
  return {
    sessionFiles,
    async *readRecords(path: string): AsyncGenerator<unknown> {
      const file = await openFile(path);
      if (!file) return;

      try {
        let first = true;
        for await (const record of parseJsonlRecords(streamSbxSession(file))) {
          if (first) {
            first = false;
            if (!isRecord(record) || record.type !== 'session' || typeof record.id !== 'string'
              || !await matchesWorkspace(record.cwd, file.workspace)) return;
            yield { ...record, cwd: file.workspace };
          } else {
            // A second header must not change the workspace during a scan.
            if (isRecord(record) && record.type === 'session') continue;
            yield record;
          }
        }
      } finally {
        await file.handle.close();
      }
    }
  };
}

async function resolveSbxSessionFiles(options: SbxSessionScope, explicitFiles?: string[]) {
  const { sbxSessionStore: store, sbxWorkspace: workspace } = options;
  if (store && workspace && isAbsolute(store) && isAbsolute(workspace)) {
    const fromWorkspace = relative(workspace, store);
    if (fromWorkspace === '..' || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) {
      try {
        if (await isCanonicalDirectory(store) && await isCanonicalDirectory(workspace)) {
          const files = explicitFiles ?? (await readdir(store)).map((name) => join(store, name));
          return {
            sessionFiles: files.filter((path) => resolve(path) === path && dirname(path) === store && extname(path) === '.jsonl'),
            openFile: (path: string) => openSbxSessionFile(path, store, workspace)
          };
        }
      } catch {
        // A missing or inaccessible SBX store never triggers local Pi discovery.
      }
    }
  }
  return { sessionFiles: [], openFile: async (_path: string) => undefined };
}

async function isCanonicalDirectory(path: string): Promise<boolean> {
  return await realpath(path) === path && (await lstat(path)).isDirectory();
}

async function openSbxSessionFile(path: string, store: string, workspace: string): Promise<SbxSessionFile | undefined> {
  let handle: FileHandle | undefined;
  try {
    // O_NOFOLLOW rejects a final-component symlink even if the entry changes
    // after enumeration. O_NONBLOCK keeps replaced FIFOs from blocking discovery.
    if (!await isCanonicalDirectory(store)) return undefined;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = await handle.stat();
    if (!stats.isFile() || await realpath(path) !== path) return undefined;
    const current = await lstat(path);
    if (!current.isFile() || stats.dev !== current.dev || stats.ino !== current.ino) return undefined;

    const buffer = Buffer.alloc(Math.min(stats.size, maxSbxHeaderBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline === -1 && bytesRead >= maxSbxHeaderBytes) return undefined;
    const header: unknown = JSON.parse(buffer.toString('utf8', 0, newline === -1 ? bytesRead : newline));
    if (!isRecord(header) || header.type !== 'session' || typeof header.id !== 'string'
      || !await matchesWorkspace(header.cwd, workspace)) return undefined;

    const file = { path, stats, handle, workspace };
    handle = undefined;
    return file;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function matchesWorkspace(value: unknown, workspace: string): Promise<boolean> {
  return typeof value === 'string' && isAbsolute(value)
    && await realpath(value) === workspace && await isCanonicalDirectory(workspace);
}

function streamSbxSession({ handle }: SbxSessionFile) {
  return handle.createReadStream({ encoding: 'utf8', start: 0, autoClose: false });
}

async function listSessionsFromDir(sessionDir: string, options: ListPiSessionsOptions): Promise<RawSessionInfo[]> {
  if (!existsSync(sessionDir)) {
    return [];
  }

  let names: string[];

  try {
    names = await readdir(sessionDir);
  } catch {
    return [];
  }

  const fileStats = await mapWithConcurrency(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(sessionDir, name)),
    maxConcurrentSessionFileReads,
    statSessionFile
  );
  const existingFiles = fileStats.filter((file): file is SessionFileStats => Boolean(file));
  const persistedCache = await readSessionMetadataCache(options.sessionMetadataCacheFile);
  const previousSessions = createPreviousSessionCache(options.previousSessions);
  const entriesByPath = new Map<string, CachedSessionInfo>();
  const readyEntries: CachedSessionInfo[] = [];
  const filesToLoadCheap: SessionFileLoad[] = [];
  const filesToParse: SessionFileStats[] = [];
  let cacheHits = 0;

  for (const file of existingFiles) {
    const cached = persistedCache.get(file.path);
    const stale = cached ?? previousSessions.get(file.path);

    if (cached && cached.mtimeMs === file.stats.mtimeMs && cached.size === file.stats.size) {
      const entry = {
        mtimeMs: cached.mtimeMs,
        size: cached.size,
        session: markSessionMetadataReady({ ...cached.session, path: file.path })
      };
      entriesByPath.set(file.path, entry);
      readyEntries.push(entry);
      cacheHits += 1;
    } else {
      filesToLoadCheap.push({ file, ...(stale ? { stale } : {}) });
    }
  }

  const publishProgress = (): void => {
    options.onProgress?.(decorateSessions(
      Array.from(entriesByPath.values()).map((entry) => entry.session),
      options.currentSessionFile
    ));
  };

  const cheapEntries = await mapWithConcurrency(
    filesToLoadCheap,
    maxConcurrentSessionFileReads,
    buildCheapSessionInfo
  );

  for (let index = 0; index < cheapEntries.length; index += 1) {
    const entry = cheapEntries[index];

    if (!entry) {
      continue;
    }

    entriesByPath.set(entry.session.path, entry);
    filesToParse.push(filesToLoadCheap[index].file);
  }

  if (entriesByPath.size > 0) {
    publishProgress();
  }

  let parsedCount = 0;
  await parseSessionInfoFiles(filesToParse, (entry) => {
    entriesByPath.set(entry.session.path, entry);
    readyEntries.push(entry);
    parsedCount += 1;

    if (parsedCount % sessionListProgressBatchSize === 0) {
      publishProgress();
    }
  });

  const entries = Array.from(entriesByPath.values());
  options.onMetrics?.({
    sessionCount: entries.length,
    totalBytes: existingFiles.reduce((total, file) => total + file.stats.size, 0),
    cacheHits,
    cacheMisses: filesToParse.length
  });

  if (parsedCount > 0 || persistedCache.size !== readyEntries.length) {
    await writeSessionMetadataCache(options.sessionMetadataCacheFile, readyEntries);
  }

  return entries.map((entry) => entry.session);
}

async function listSessionCandidatesFromDir(sessionDir: string): Promise<PiSessionCandidate[]> {
  if (!existsSync(sessionDir)) {
    return [];
  }

  let names: string[];

  try {
    names = await readdir(sessionDir);
  } catch {
    return [];
  }

  const sessions = await mapWithConcurrency(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(sessionDir, name)),
    maxConcurrentSessionFileReads,
    buildSessionCandidate
  );

  return sessions.filter((session): session is PiSessionCandidate => Boolean(session));
}

function createPreviousSessionCache(sessions: ListPiSessionsOptions['previousSessions']): Map<string, CachedSessionInfo> {
  const cache = new Map<string, CachedSessionInfo>();

  for (const session of sessions ?? []) {
    cache.set(session.path, {
      mtimeMs: Number.NaN,
      size: Number.NaN,
      session: { ...session }
    });
  }

  return cache;
}

function decorateSessions(
  sessions: RawSessionInfo[],
  currentSessionFile: string | undefined
): SessionListItem[] {
  return decorateSessionTree(sessions, currentSessionFile);
}

async function resolveConfiguredSessionDir(
  cwd: string | undefined,
  currentSessionFile: string | undefined,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const envSessionDir = env[piSessionDirEnvName];

  if (envSessionDir) {
    return resolveSessionDirPath(envSessionDir, cwd);
  }

  const settingsSessionDir = await readConfiguredSessionDir(cwd);

  if (settingsSessionDir) {
    return resolveSessionDirPath(settingsSessionDir, cwd);
  }

  if (cwd) {
    return getDefaultSessionDir(cwd);
  }

  return currentSessionFile ? dirname(currentSessionFile) : undefined;
}

async function readConfiguredSessionDir(cwd: string | undefined): Promise<string | undefined> {
  const [globalSettings, projectSettings] = await Promise.all([
    readSettings(join(homedir(), '.pi', 'agent', 'settings.json')),
    cwd ? readSettings(join(cwd, '.pi', 'settings.json')) : Promise.resolve(undefined)
  ]);

  const value = projectSettings?.sessionDir ?? globalSettings?.sessionDir;
  return typeof value === 'string' && value ? value : undefined;
}

async function readSettings(path: string): Promise<{ sessionDir?: unknown } | undefined> {
  try {
    const content = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function getDefaultSessionDir(cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return join(getDefaultSessionsRoot(), safePath);
}

function getDefaultSessionsRoot(): string {
  return join(homedir(), '.pi', 'agent', 'sessions');
}

function resolveSessionDirPath(path: string, cwd: string | undefined): string {
  const expanded = expandTildePath(path);
  return isAbsolute(expanded) || !cwd ? expanded : resolve(cwd, expanded);
}

function expandTildePath(path: string): string {
  if (path === '~') {
    return homedir();
  }

  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

async function buildSessionCandidate(filePath: string): Promise<PiSessionCandidate | undefined> {
  try {
    const stats = await stat(filePath);
    const header = await readSessionJsonlHeader(filePath);

    if (!header || typeof header.id !== 'string') {
      return undefined;
    }

    return {
      path: filePath,
      id: header.id,
      cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
      mtimeMs: stats.mtimeMs,
      size: stats.size
    };
  } catch {
    return undefined;
  }
}

async function buildSessionInfo(filePath: string, knownStats?: Stats): Promise<RawSessionInfo | undefined> {
  try {
    const stats = knownStats ?? await stat(filePath);
    const session = await readSessionSummary(filePath, stats);

    return session ? markSessionMetadataReady(session) : undefined;
  } catch {
    return undefined;
  }
}

async function buildCheapSessionInfo(load: SessionFileLoad): Promise<CachedSessionInfo | undefined> {
  const { file, stale } = load;

  try {
    const header = await readSessionJsonlHeader(file.path);

    if (!header || typeof header.id !== 'string') {
      return undefined;
    }

    const created = parseDate(header.timestamp, file.stats.mtime);
    const staleSession = stale?.session.id === header.id ? stale.session : undefined;
    return {
      mtimeMs: file.stats.mtimeMs,
      size: file.stats.size,
      session: {
        path: file.path,
        id: header.id,
        cwd: typeof header.cwd === 'string' ? header.cwd : staleSession?.cwd ?? '',
        parentSessionPath: typeof header.parentSession === 'string' ? header.parentSession : staleSession?.parentSessionPath,
        created: staleSession?.created ?? created.toISOString(),
        modified: staleSession?.modified ?? file.stats.mtime.toISOString(),
        messageCount: staleSession?.messageCount ?? 0,
        firstMessage: staleSession?.firstMessage ?? 'Loading metadata…',
        ...(staleSession?.name ? { name: staleSession.name } : {}),
        metadataState: 'loading'
      }
    };
  } catch {
    return undefined;
  }
}

async function statSessionFile(filePath: string): Promise<SessionFileStats | undefined> {
  try {
    return { path: filePath, stats: await stat(filePath) };
  } catch {
    return undefined;
  }
}

async function parseSessionInfoFiles(
  files: SessionFileStats[],
  onSession: (entry: CachedSessionInfo) => void
): Promise<void> {
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= files.length) {
        return;
      }

      const file = files[index];
      const session = await buildSessionInfo(file.path, file.stats);

      if (session) {
        onSession({
          mtimeMs: file.stats.mtimeMs,
          size: file.stats.size,
          session
        });
      }
    }
  }

  const workerCount = Math.min(maxConcurrentSessionFileReads, files.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
}

function markSessionMetadataReady(session: RawSessionInfo): RawSessionInfo {
  return { ...session, metadataState: 'ready' };
}

function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string') {
    return fallback;
  }

  const time = new Date(value).getTime();
  return Number.isNaN(time) ? fallback : new Date(time);
}
