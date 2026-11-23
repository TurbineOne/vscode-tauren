import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { EditOperations, EditToolInput } from '@earendil-works/pi-coding-agent';
import type {
  ChangeReviewPreview,
  ChangeReviewPreviewOptions,
  ChangeReviewToolName,
  EditToolDefinitionFactory
} from './types.js';

const reviewableToolNames = new Set<string>(['edit', 'write', 'hashline_edit']);

const imageExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tif', '.tiff', '.heic', '.avif'
]);

const hashlineChars = 'ZPMQVRWSNKTXJBYH';
const hashlineDict = Array.from({ length: 256 }, (_, index) => {
  const high = index >>> 4;
  const low = index & 0x0f;
  return `${hashlineChars[high]}${hashlineChars[low]}`;
});

interface HashlineOperation {
  op: 'replace_range' | 'delete_range' | 'insert_after' | 'insert_before';
  start?: string;
  end?: string;
  anchor?: string;
  content?: string | string[] | null;
}

export function isReviewableToolName(toolName: string): toolName is ChangeReviewToolName {
  return reviewableToolNames.has(toolName);
}

/**
 * Compute an in-memory before-and-after preview for a file-modifying tool call.
 * Returns undefined when the arguments cannot produce a valid text preview so
 * the underlying tool can run and report its own validation error.
 */
export async function computeChangeReviewPreview(
  toolName: ChangeReviewToolName,
  input: unknown,
  cwd: string,
  options: ChangeReviewPreviewOptions
): Promise<ChangeReviewPreview | undefined> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  if (typeof record.path !== 'string' || !record.path.trim()) {
    return undefined;
  }

  const rawPath = record.path;
  const absolutePath = resolveToCwd(rawPath, cwd);
  const displayPath = formatDisplayPath(rawPath, absolutePath, cwd);

  if (toolName === 'write') {
    return computeWritePreview(displayPath, absolutePath, record);
  }

  if (toolName === 'edit') {
    return computeEditPreview(rawPath, cwd, record, options.createEditToolDefinition);
  }

  return computeHashlinePreview(displayPath, absolutePath, record);
}

async function computeWritePreview(
  displayPath: string,
  absolutePath: string,
  input: Record<string, unknown>
): Promise<ChangeReviewPreview | undefined> {
  if (typeof input.content !== 'string') {
    return undefined;
  }

  if (isImageExtension(absolutePath)) {
    return undefined;
  }

  const afterText = normalizeToLF(input.content);

  try {
    const rawBuffer = await readFile(absolutePath);
    if (isBinaryBuffer(absolutePath, rawBuffer)) {
      return undefined;
    }

    const beforeText = normalizeToLF(stripBom(rawBuffer.toString('utf-8')).text);
    return {
      toolName: 'write',
      path: displayPath,
      absolutePath,
      beforeText,
      afterText,
      isNewFile: false
    };
  } catch (error) {
    if (isEnoent(error)) {
      return {
        toolName: 'write',
        path: displayPath,
        absolutePath,
        beforeText: '',
        afterText,
        isNewFile: true
      };
    }

    return undefined;
  }
}

/**
 * Reuse Pi's built-in edit tool definition with dry-run filesystem operations
 * so the preview uses Pi's exact argument preparation, fuzzy matching,
 * uniqueness checks, and line-ending preservation without writing to disk.
 */
async function computeEditPreview(
  rawPath: string,
  cwd: string,
  input: Record<string, unknown>,
  createEditToolDefinition: EditToolDefinitionFactory
): Promise<ChangeReviewPreview | undefined> {
  let beforeText: string | undefined;
  let afterText: string | undefined;
  let resolvedAbsolutePath: string | undefined;

  const dryRunOperations: EditOperations = {
    access: async (targetPath) => {
      await access(targetPath, fsConstants.R_OK);
    },
    readFile: async (targetPath) => {
      const buffer = await readFile(targetPath);
      if (isBinaryBuffer(targetPath, buffer)) {
        throw new Error('Binary file preview skipped.');
      }
      resolvedAbsolutePath = targetPath;
      beforeText = normalizeToLF(stripBom(buffer.toString('utf-8')).text);
      return buffer;
    },
    writeFile: async (targetPath, content) => {
      resolvedAbsolutePath = targetPath;
      afterText = normalizeToLF(stripBom(content).text);
    }
  };

  try {
    const editTool = createEditToolDefinition(cwd, { operations: dryRunOperations });
    const preparedInput = editTool.prepareArguments ? editTool.prepareArguments({ ...input }) : input;
    await editTool.execute(
      'tauren-review-preview',
      preparedInput as EditToolInput,
      undefined,
      undefined,
      { cwd } as never
    );
  } catch {
    return undefined;
  }

  if (beforeText === undefined || afterText === undefined || !resolvedAbsolutePath) {
    return undefined;
  }

  return {
    toolName: 'edit',
    path: formatDisplayPath(rawPath, resolvedAbsolutePath, cwd),
    absolutePath: resolvedAbsolutePath,
    beforeText,
    afterText,
    isNewFile: false
  };
}

async function computeHashlinePreview(
  displayPath: string,
  absolutePath: string,
  input: Record<string, unknown>
): Promise<ChangeReviewPreview | undefined> {
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    return undefined;
  }

  const operations = input.operations as HashlineOperation[];

  try {
    await access(absolutePath, fsConstants.R_OK);
    const rawBuffer = await readFile(absolutePath);
    if (isBinaryBuffer(absolutePath, rawBuffer)) {
      return undefined;
    }

    const beforeText = normalizeToLF(stripBom(rawBuffer.toString('utf-8')).text);
    const afterText = applyHashlineOperations(beforeText, operations);
    if (afterText === undefined) {
      return undefined;
    }

    return {
      toolName: 'hashline_edit',
      path: displayPath,
      absolutePath,
      beforeText,
      afterText,
      isNewFile: false
    };
  } catch {
    return undefined;
  }
}

function applyHashlineOperations(beforeText: string, operations: HashlineOperation[]): string | undefined {
  const originalLines = beforeText.split('\n');
  const tagsToVerify: Array<{ line: number; hash: string }> = [];

  for (const op of operations) {
    if (!op || typeof op !== 'object') {
      return undefined;
    }

    if (op.op === 'replace_range' || op.op === 'delete_range') {
      if (typeof op.start !== 'string' || typeof op.end !== 'string') {
        return undefined;
      }
      const start = parseHashlineTag(op.start);
      const end = parseHashlineTag(op.end);
      if (!start || !end || end.line < start.line) {
        return undefined;
      }
      if (op.op === 'replace_range' && op.content === undefined) {
        return undefined;
      }
      tagsToVerify.push(start, end);
      continue;
    }

    if (op.op === 'insert_after' || op.op === 'insert_before') {
      if (typeof op.anchor !== 'string' || op.content === undefined) {
        return undefined;
      }
      const anchor = parseHashlineTag(op.anchor);
      const insertLines = parseHashlineContent(op.content);
      if (!anchor || !insertLines || insertLines.length === 0) {
        return undefined;
      }
      tagsToVerify.push(anchor);
      continue;
    }

    return undefined;
  }

  for (const tag of tagsToVerify) {
    const index = tag.line - 1;
    if (index < 0 || index >= originalLines.length) {
      return undefined;
    }
    if (computeHashlineTag(originalLines[index]!) !== tag.hash) {
      return undefined;
    }
  }

  const splices: Array<{ at: number; deleteCount: number; insert: string[] }> = [];
  for (const op of operations) {
    if (op.op === 'replace_range' || op.op === 'delete_range') {
      const start = parseHashlineTag(op.start!)!;
      const end = parseHashlineTag(op.end!)!;
      const insert = op.op === 'replace_range' ? parseHashlineContent(op.content) : [];
      if (!insert) {
        return undefined;
      }
      splices.push({ at: start.line - 1, deleteCount: end.line - start.line + 1, insert });
    } else {
      const anchor = parseHashlineTag(op.anchor!)!;
      const insert = parseHashlineContent(op.content);
      if (!insert || insert.length === 0) {
        return undefined;
      }
      splices.push({ at: op.op === 'insert_after' ? anchor.line : anchor.line - 1, deleteCount: 0, insert });
    }
  }

  const deleteRanges = splices
    .filter((splice) => splice.deleteCount > 0)
    .map((splice) => ({ start: splice.at, end: splice.at + splice.deleteCount - 1 }))
    .sort((left, right) => left.start - right.start);

  for (let index = 1; index < deleteRanges.length; index += 1) {
    if (deleteRanges[index]!.start <= deleteRanges[index - 1]!.end) {
      return undefined;
    }
  }

  splices.sort((left, right) => right.at - left.at);
  const nextLines = [...originalLines];
  for (const splice of splices) {
    if (splice.at < 0 || splice.at > nextLines.length) {
      return undefined;
    }
    nextLines.splice(splice.at, splice.deleteCount, ...splice.insert);
  }

  return nextLines.join('\n');
}

function parseHashlineTag(tag: string): { line: number; hash: string } | undefined {
  const match = tag.match(/^\s*[>+-]*\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/i);
  if (!match) {
    return undefined;
  }

  const line = Number(match[1]);
  if (!Number.isFinite(line) || line < 1) {
    return undefined;
  }

  return { line, hash: match[2]!.toUpperCase() };
}

function computeHashlineTag(lineText: string): string {
  let clean = lineText.endsWith('\r') ? lineText.slice(0, -1) : lineText;
  if (clean.startsWith('\uFEFF')) {
    clean = clean.slice(1);
  }
  const normalized = clean.replace(/\s+/g, '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hashlineDict[(hash >>> 0) & 0xff]!;
}

function parseHashlineContent(content: string | string[] | null | undefined): string[] | undefined {
  if (content === null || content === undefined) {
    return [];
  }

  if (Array.isArray(content)) {
    for (const line of content) {
      if (typeof line !== 'string' || line.includes('\n') || line.includes('\r')) {
        return undefined;
      }
    }
    return content;
  }

  if (typeof content !== 'string') {
    return undefined;
  }

  const lines = normalizeToLF(content).split('\n');
  if (lines.length === 0) {
    return [];
  }
  if (lines[lines.length - 1]?.trim() === '') {
    return lines.slice(0, -1);
  }
  return lines;
}

function stripBom(text: string): { bom: string; text: string } {
  if (text.startsWith('\uFEFF')) {
    return { bom: '\uFEFF', text: text.slice(1) };
  }
  return { bom: '', text };
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function resolveToCwd(inputPath: string, cwd: string): string {
  const withoutAt = inputPath.startsWith('@') ? inputPath.slice(1) : inputPath;
  const expanded = withoutAt === '~'
    ? homedir()
    : withoutAt.startsWith('~/')
      ? path.join(homedir(), withoutAt.slice(2))
      : withoutAt;

  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
}

function formatDisplayPath(rawPath: string, absolutePath: string, cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const relative = path.relative(resolvedCwd, absolutePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.replace(/\\/g, '/');
  }
  const trimmed = rawPath.startsWith('@') ? rawPath.slice(1) : rawPath;
  return trimmed.replace(/\\/g, '/');
}

function isImageExtension(filePath: string): boolean {
  return imageExtensions.has(path.extname(filePath).toLowerCase());
}

function isBinaryBuffer(filePath: string, buffer: Buffer): boolean {
  if (isImageExtension(filePath)) {
    return true;
  }
  if (buffer.includes(0)) {
    return true;
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  if (sample.length === 0) {
    return false;
  }

  let suspicious = 0;
  for (const byte of sample) {
    const isAllowedControl = byte === 9 || byte === 10 || byte === 13;
    const isPrintableAscii = byte >= 32 && byte <= 126;
    const isExtendedUtf8Byte = byte >= 128;
    if (!isAllowedControl && !isPrintableAscii && !isExtendedUtf8Byte) {
      suspicious += 1;
    }
  }

  return suspicious / sample.length > 0.15;
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}
