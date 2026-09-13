/**
 * Resolve a caller-supplied filesystem path and reject it if it escapes the
 * allowed bases. Relative paths stay under `process.cwd()` (in-tree).
 * Absolute paths under `os.tmpdir()` remain valid for tests and scratch files.
 */

import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Thrown when a path resolves outside every allowed base directory. */
export class PathEscapeError extends Error {
  constructor(userPath: string) {
    super(`path escapes allowed directory: ${userPath}`);
    this.name = "PathEscapeError";
  }
}

function isInsideBase(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Bases a resolved path may live under: cwd (in-tree) and the OS temp dir. */
export function allowedPathBases(): string[] {
  return [resolve(process.cwd()), resolve(tmpdir())];
}

/**
 * Resolve `userPath` (relative to cwd) and return the absolute path if it
 * stays under an allowed base. Rejects `..` traversal and other escapes.
 */
export function confinePath(userPath: string): string {
  if (typeof userPath !== "string" || userPath.trim() === "") {
    throw new PathEscapeError(userPath);
  }
  const resolved = resolve(userPath);
  if (allowedPathBases().some((base) => isInsideBase(base, resolved))) {
    return resolved;
  }
  throw new PathEscapeError(userPath);
}
