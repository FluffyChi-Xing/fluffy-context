import { readFile } from 'node:fs/promises';

export class JsonStoreError extends Error {
  constructor(public readonly filePath: string, message: string) {
    super(`${message}: ${filePath}`);
    this.name = 'JsonStoreError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readJson<T>(filePath: string, validate?: (value: unknown) => value is T): Promise<T> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new JsonStoreError(filePath, 'invalid JSON');
    throw error;
  }
  if (validate && !validate(value)) throw new JsonStoreError(filePath, 'invalid data schema');
  return value as T;
}
