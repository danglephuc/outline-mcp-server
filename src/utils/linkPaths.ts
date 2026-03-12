import path from 'node:path';

/**
 * Compute a relative path from one file to another, formatted for Markdown links:
 * - Always uses POSIX separators (`/`) regardless of OS.
 * - Adds `./` prefix for same-dir or child paths (e.g. `Child.md` -> `./Child.md`).
 * - Preserves `../` paths as-is.
 */
export function formatPosixRelativeMarkdownPath(fromFilePath: string, toFilePath: string): string {
  const fromDir = path.dirname(fromFilePath);
  let rel = path.relative(fromDir, toFilePath);

  // path.relative can return '' if both paths are identical.
  if (!rel) rel = path.basename(toFilePath);

  // Normalize to POSIX separators even on Windows.
  let posixRel = rel.replace(/\\/g, '/');

  // Ensure explicit relative marker for same-folder/subfolder links.
  if (!posixRel.startsWith('.') && !posixRel.startsWith('/')) {
    posixRel = `./${posixRel}`;
  }

  return posixRel;
}

