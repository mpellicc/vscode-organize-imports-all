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

async function getGitTopLevel(cwd: string): Promise<string | null> {
  const res = await runGit(['rev-parse', '--show-toplevel'], cwd);
  if (res.exitCode !== 0) {
    return null;
  }
  const topLevel = res.stdout.toString('utf8').trim();
  if (!topLevel) {
    return null;
  }
  return path.resolve(cwd, topLevel);
}

function isWithinDirectory(parentDir: string, candidatePath: string): boolean {
  const rel = path.relative(parentDir, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function findNearestGitRoot(
  filePath: string,
  stopAtDir: string,
  fallbackRoot: string | null,
  dirCache: Map<string, string | null>
): string | null {
  const resolvedStop = path.resolve(stopAtDir);
  let current = path.dirname(path.resolve(filePath));
  const visited: string[] = [];

  while (isWithinDirectory(resolvedStop, current)) {
    if (dirCache.has(current)) {
      const cached = dirCache.get(current) ?? null;
      for (const dir of visited) {
        dirCache.set(dir, cached);
      }
      return cached;
    }

    if (fs.existsSync(path.join(current, '.git'))) {
      dirCache.set(current, current);
      for (const dir of visited) {
        dirCache.set(dir, current);
      }
      return current;
    }

    visited.push(current);
    if (current === resolvedStop) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  for (const dir of visited) {
    dirCache.set(dir, fallbackRoot);
  }
  return fallbackRoot;
}

/**
 * Filters out paths ignored by `.gitignore` / Git exclude rules using
 * `git check-ignore -z --stdin`, grouping files by their nearest Git root so
 * nested repositories, parent workspaces, and submodules are handled safely.
 */
export async function filterGitIgnoredFiles(
  cwd: string,
  filePaths: readonly string[]
): Promise<{ kept: string[]; ignoredCount: number }> {
  if (filePaths.length === 0) {
    return { kept: [], ignoredCount: 0 };
  }

  const fallbackRoot = await getGitTopLevel(cwd);
  const dirCache = new Map<string, string | null>();
  const buckets = new Map<string, string[]>();

  for (const filePath of filePaths) {
    const repoRoot = findNearestGitRoot(filePath, cwd, fallbackRoot, dirCache);
    if (!repoRoot) {
      continue;
    }
    let group = buckets.get(repoRoot);
    if (!group) {
      group = [];
      buckets.set(repoRoot, group);
    }
    group.push(filePath);
  }

  const ignoredSet = new Set<string>();

  for (const [repoRoot, groupFiles] of buckets.entries()) {
    const relPaths: string[] = [];
    for (const filePath of groupFiles) {
      const rel = path.relative(repoRoot, filePath);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        relPaths.push(rel);
      }
    }

    if (relPaths.length === 0) {
      continue;
    }

    const stdinBuffer = Buffer.from(relPaths.join('\0') + '\0', 'utf8');
    const res = await runGit(['check-ignore', '-z', '--stdin'], repoRoot, stdinBuffer);
    if (res.exitCode !== 0) {
      continue;
    }

    for (const rel of res.stdout.toString('utf8').split('\0')) {
      if (rel) {
        ignoredSet.add(path.resolve(repoRoot, rel));
      }
    }
  }

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
