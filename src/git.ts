import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface GitResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

function runGit(
  args: readonly string[],
  cwd: string,
  stdinBuffer?: Buffer
): Promise<GitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: GitResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const child = spawn('git', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    // Guard against EPIPE if git exits early (e.g. non-Git folder).
    child.stdin.on('error', () => {});

    child.on('error', () => {
      finish({
        exitCode: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });
    });

    child.on('close', (exitCode) => {
      finish({
        exitCode,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    });

    if (stdinBuffer && stdinBuffer.length > 0) {
      child.stdin.write(stdinBuffer);
    }
    child.stdin.end();
  });
}

/**
 * Returns `true` when `cwd` is inside a Git working tree.
 */
export async function isGitRepository(cwd: string): Promise<boolean> {
  const res = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  return res.exitCode === 0 && res.stdout.toString('utf8').trim() === 'true';
}

/**
 * Filters out paths ignored by `.gitignore` / Git exclude rules using
 * `git check-ignore -z --stdin`. Keeps all paths if `cwd` is not a Git repo.
 */
export async function filterGitIgnoredFiles(
  cwd: string,
  filePaths: readonly string[]
): Promise<{ kept: string[]; ignoredCount: number }> {
  if (filePaths.length === 0) {
    return { kept: [], ignoredCount: 0 };
  }

  const relPaths: string[] = [];
  for (const filePath of filePaths) {
    const rel = path.relative(cwd, filePath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      relPaths.push(rel);
    }
  }

  if (relPaths.length === 0) {
    return { kept: [...filePaths], ignoredCount: 0 };
  }

  const stdinBuffer = Buffer.from(relPaths.join('\0') + '\0', 'utf8');
  const res = await runGit(['check-ignore', '-z', '--stdin'], cwd, stdinBuffer);

  // Exit code 0 means at least one path matched an ignore rule.
  // Exit code 1 means nothing was ignored; 128/null means not a Git repo/error.
  if (res.exitCode !== 0) {
    return { kept: [...filePaths], ignoredCount: 0 };
  }

  const ignoredEntries = res.stdout.toString('utf8').split('\0').filter(Boolean);
  const ignoredSet = new Set<string>(
    ignoredEntries.map((rel) => path.resolve(cwd, rel))
  );

  const kept = filePaths.filter((filePath) => !ignoredSet.has(path.resolve(filePath)));
  return {
    kept,
    ignoredCount: filePaths.length - kept.length,
  };
}

/**
 * Collects staged, unstaged modified, and untracked non-ignored files within `cwd`.
 */
export async function getGitChangedFiles(
  cwd: string
): Promise<{ isRepo: boolean; files: string[] }> {
  if (!(await isGitRepository(cwd))) {
    return { isRepo: false, files: [] };
  }

  const [stagedRes, workingRes] = await Promise.all([
    runGit(['diff', '--name-only', '--cached', '--diff-filter=ACMR', '-z', '--relative'], cwd),
    runGit(['ls-files', '--modified', '--others', '--exclude-standard', '-z'], cwd),
  ]);

  const absPaths = new Set<string>();
  for (const res of [stagedRes, workingRes]) {
    if (res.exitCode !== 0) {
      continue;
    }
    for (const rel of res.stdout.toString('utf8').split('\0')) {
      if (!rel) {
        continue;
      }
      const absPath = path.resolve(cwd, rel);
      if (fs.existsSync(absPath)) {
        absPaths.add(absPath);
      }
    }
  }

  return {
    isRepo: true,
    files: Array.from(absPaths).sort((a, b) => a.localeCompare(b)),
  };
}
