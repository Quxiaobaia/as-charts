/**
 * Clear the coverage output directory before a coverage run.
 *
 * Vitest clears `coverage.reportsDirectory` itself, with `fs.rm(path, { recursive:
 * true })`. On a normal machine that is the end of the story. In some sandboxed
 * environments — this one included — `fs.rm` is replaced by a shim that routes
 * deletions through the OS trash, and that shim's trash step **fails on a
 * directory**: the run aborts before a single test executes, with
 * `Error during a 'trash' operation: Some operations were aborted`.
 *
 * Deleting depth-first with `unlink`/`rmdir` reaches the same end state without
 * going near the trash, and is portable: `fs.rmSync`'s recursive mode and the
 * `rm`/`find` shell commands are not. Running this as `pretest:coverage` also
 * means the *reason* a stale report would be wrong is handled explicitly rather
 * than by trusting a tool's default: v8 merges whatever `.tmp/*.json` it finds,
 * so a directory left over from an earlier run inflates the numbers.
 */
import { existsSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const target = process.argv[2] ?? 'coverage';

if (!existsSync(target)) {
  // Nothing to do. Saying so would be noise on the common path.
  process.exit(0);
}

function clear(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) clear(path);
    else unlinkSync(path);
  }
  rmdirSync(directory);
}

try {
  clear(target);
} catch (error) {
  // A failure here is not fatal: vitest will report its own error if the
  // directory really cannot be replaced, and that message is more specific.
  console.warn(
    `clean-coverage: could not clear ${target}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
