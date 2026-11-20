import { createReadStream } from 'node:fs';

export async function* parseJsonlFileRecords(filePath: string): AsyncGenerator<unknown> {
  yield* parseJsonlRecords(createReadStream(filePath, { encoding: 'utf8' }));
}

export async function* parseJsonlRecords(chunks: AsyncIterable<string>): AsyncGenerator<unknown> {
  let buffer = '';

  for await (const chunk of chunks) {
    buffer += chunk;

    for (;;) {
      const lineEnd = buffer.indexOf('\n');

      if (lineEnd === -1) {
        break;
      }

      const record = parseJsonlLine(buffer.slice(0, lineEnd));
      if (record !== undefined) {
        yield record;
      }
      buffer = buffer.slice(lineEnd + 1);
    }
  }

  const record = parseJsonlLine(buffer);
  if (record !== undefined) {
    yield record;
  }
}

function parseJsonlLine(line: string): unknown | undefined {
  const trimmed = line.trim();

  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
