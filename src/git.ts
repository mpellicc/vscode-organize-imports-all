import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GitCommandOptions {
  signal?: AbortSignal;
}

export type GitFailureCode =
  | 'git-not-found'
  | 'cwd-not-found'
  | 'unborn-head'
  | 'invalid-ref'
  | 'no-merge-base'
  | 'git-failed';

export interface GitFailure {
  code: GitFailureCode;
  message: string;
  cwd: string;
  command: string;
  exitCode: number | null;
  stderr?: string;
}

export type GitRepositoryProbe =
  | { status: 'repo'; topLevel: string }
  | { status: 'not-repo' }
  | { status: 'aborted' }
  | { status: 'error'; error: GitFailure };

export interface FilterGitIgnoredResult {
  kept: string[];
  ignoredCount: number;
  failures?: GitFailure[];
  aborted?: boolean;
}

export interface GitChangedFilesResult {
  isRepo: boolean;
  files: string[];
  error?: GitFailure;
  aborted?: boolean;
}

export interface GitBranchCommittedFilesResult {
  isRepo: boolean;
  baseRef: string;
  mergeBase?: string;
  files: string[];
  error?: GitFailure;
  aborted?: boolean;
}

export interface DiscoveredGitRepository {
  cwd: string;
  topLevel: string;
  workspaceRoot: string;
}

export interface DiscoverGitRepositoriesOptions extends GitCommandOptions {
  maxDepth?: number;
  maxDirectories?: number;
  knownRepoRoots?: readonly string[];
}

export interface DiscoverGitRepositoriesResult {
  repositories: DiscoveredGitRepository[];
  errors: GitFailure[];
  truncated: boolean;
  aborted: boolean;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_DIRECTORIES = 4000;
const DISCOVERY_PRUNE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'coverage', '.venv', 'venv', '__pycache__', 'target', 'vendor',
  '.cache', '.turbo', '.parcel-cache', '.gradle', '.idea', '.vscode-test',
]);

interface GitResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  spawnError?: NodeJS.ErrnoException;
  aborted: boolean;
}

interface RunGitOptions extends GitCommandOptions {
  stdinBuffer?: Buffer;
}

function directoryExistsSync(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function isSurvivingRegularFile(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function hasGitMarkerSync(dirPath: string): boolean {
  try {
    const stat = fs.lstatSync(path.join(dirPath, '.git'));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function canonicalizePathSync(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function normalizePathKey(targetPath: string): string {
  const canonical = canonicalizePathSync(targetPath);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function isWithinDirectory(parentDir: string, candidatePath: string): boolean {
  const rel = path.relative(parentDir, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function collectSurvivingFiles(cwd: string, buffers: readonly Buffer[]): string[] {
  const absPaths = new Set<string>();
  for (const buf of buffers) {
    for (const rel of buf.toString('utf8').split('\0')) {
      if (!rel) {
        continue;
      }
      const absPath = path.resolve(cwd, rel);
      if (isSurvivingRegularFile(absPath)) {
        absPaths.add(absPath);
      }
    }
  }
  return Array.from(absPaths).sort((a, b) => a.localeCompare(b));
}

function buildCommandFailure(
  code: GitFailureCode,
  args: readonly string[],
  cwd: string,
  res: GitResult,
  fallbackMessage?: string
): GitFailure {
  const command = `git ${args.join(' ')}`;
  if (res.spawnError) {
    if (res.spawnError.code === 'ENOENT') {
      const missingCwd = !directoryExistsSync(cwd);
      return {
        code: missingCwd ? 'cwd-not-found' : 'git-not-found',
        message: missingCwd
          ? `Working directory does not exist: ${cwd}`
          : 'Git executable not found in PATH.',
        cwd,
        command,
        exitCode: null,
      };
    }
    return {
      code: 'git-failed',
      message: `Failed to start git: ${res.spawnError.message}`,
      cwd,
      command,
      exitCode: null,
    };
  }

  const stderr = res.stderr.toString('utf8').trim();
  return {
    code,
    message: stderr || fallbackMessage || `exit code ${res.exitCode ?? 'unknown'}`,
    cwd,
    command,
    exitCode: res.exitCode,
    ...(stderr ? { stderr } : {}),
  };
}

function runGit(
  args: readonly string[],
  cwd: string,
  options?: RunGitOptions
): Promise<GitResult> {
  const signal = options?.signal;
  if (signal?.aborted) {
    return Promise.resolve({
      exitCode: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      aborted: true,
    });
  }

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
      signal,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        LC_MESSAGES: 'C',
        LANGUAGE: 'C',
      },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.stdin.on('error', () => {});

    child.on('error', (err: NodeJS.ErrnoException) => {
      const aborted =
        Boolean(signal?.aborted) || err.name === 'AbortError' || err.code === 'ABORT_ERR';
      finish({
        exitCode: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        ...(aborted ? {} : { spawnError: err }),
        aborted,
      });
    });

    child.on('close', (exitCode) => {
      finish({
        exitCode,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        aborted: Boolean(signal?.aborted),
      });
    });

    if (options?.stdinBuffer?.length) {
      child.stdin.write(options.stdinBuffer);
    }
    child.stdin.end();
  });
}

/**
 * Probes whether `cwd` is inside a Git working tree, distinguishing non-Git
 * directories from fatal Git errors and cancellation.
 */
export async function probeGitRepository(
  cwd: string,
  options?: GitCommandOptions
): Promise<GitRepositoryProbe> {
  const args = ['rev-parse', '--is-inside-work-tree', '--show-toplevel'];
  const res = await runGit(args, cwd, options);

  if (res.aborted) {
    return { status: 'aborted' };
  }
  if (res.spawnError) {
    return { status: 'error', error: buildCommandFailure('git-failed', args, cwd, res) };
  }

  const stdout = res.stdout.toString('utf8').trim();
  if (res.exitCode === 0) {
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines[0] === 'true' && lines[1]) {
      return { status: 'repo', topLevel: path.resolve(cwd, lines[1]) };
    }
    return { status: 'not-repo' };
  }

  const stderr = res.stderr.toString('utf8');
  if (
    stdout === 'false' ||
    /this operation must be run in a work tree/i.test(stderr) ||
    /not a git repository \(or any (?:of the parent directories|parent up to mount point)/i.test(
      stderr
    )
  ) {
    return { status: 'not-repo' };
  }

  return { status: 'error', error: buildCommandFailure('git-failed', args, cwd, res) };
}

/**
 * Returns `true` when `cwd` is inside a Git working tree.
 */
export async function isGitRepository(
  cwd: string,
  options?: GitCommandOptions
): Promise<boolean> {
  return (await probeGitRepository(cwd, options)).status === 'repo';
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

    if (hasGitMarkerSync(current)) {
      dirCache.set(current, current);
      for (const dir of visited) {
        dirCache.set(dir, current);
      }
      return current;
    }

    visited.push(current);
    const parent = path.dirname(current);
    if (current === resolvedStop || parent === current) {
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
  filePaths: readonly string[],
  options?: GitCommandOptions
): Promise<FilterGitIgnoredResult> {
  const signal = options?.signal;
  if (signal?.aborted) {
    return { kept: [], ignoredCount: 0, aborted: true };
  }
  if (filePaths.length === 0) {
    return { kept: [], ignoredCount: 0 };
  }

  const probe = await probeGitRepository(cwd, options);
  if (probe.status === 'aborted') {
    return { kept: [], ignoredCount: 0, aborted: true };
  }

  const failures: GitFailure[] = [];
  let fallbackRoot: string | null = null;
  if (probe.status === 'repo') {
    fallbackRoot = probe.topLevel;
  } else if (probe.status === 'error') {
    failures.push(probe.error);
    if (probe.error.code === 'git-not-found') {
      return { kept: [...filePaths], ignoredCount: 0, failures };
    }
  }

  const dirCache = new Map<string, string | null>();
  const buckets = new Map<string, string[]>();
  for (const filePath of filePaths) {
    const repoRoot = findNearestGitRoot(filePath, cwd, fallbackRoot, dirCache);
    if (!repoRoot) {
      continue;
    }
    const group = buckets.get(repoRoot) ?? [];
    if (group.length === 0) {
      buckets.set(repoRoot, group);
    }
    group.push(filePath);
  }

  const ignoredSet = new Set<string>();
  const checkIgnoreArgs = ['check-ignore', '-z', '--stdin'];
  const abortResult = (): FilterGitIgnoredResult => ({
    kept: [],
    ignoredCount: 0,
    aborted: true,
    ...(failures.length > 0 ? { failures } : {}),
  });

  for (const [repoRoot, groupFiles] of buckets.entries()) {
    if (signal?.aborted) {
      return abortResult();
    }

    const relPaths: string[] = [];
    const relToResolved = new Map<string, string[]>();
    for (const filePath of groupFiles) {
      const resolvedFile = path.resolve(filePath);
      let rel = path.relative(repoRoot, resolvedFile);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        rel = path.relative(repoRoot, canonicalizePathSync(resolvedFile));
      }
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        continue;
      }

      const gitRel = rel.split(path.sep).join('/');
      const mapped = relToResolved.get(gitRel) ?? [];
      if (mapped.length === 0) {
        relToResolved.set(gitRel, mapped);
        relPaths.push(gitRel);
      }
      mapped.push(resolvedFile);
    }

    if (relPaths.length === 0) {
      continue;
    }

    const stdinBuffer = Buffer.from(relPaths.join('\0') + '\0', 'utf8');
    const res = await runGit(checkIgnoreArgs, repoRoot, { signal, stdinBuffer });
    if (res.aborted) {
      return abortResult();
    }

    // git-check-ignore exit codes: 0 = ignored matches found, 1 = none ignored, >=2 = fatal error.
    if (res.spawnError || (res.exitCode !== 0 && res.exitCode !== 1)) {
      failures.push(buildCommandFailure('git-failed', checkIgnoreArgs, repoRoot, res));
      continue;
    }
    if (res.exitCode === 1) {
      continue;
    }

    for (const rel of res.stdout.toString('utf8').split('\0')) {
      if (!rel) {
        continue;
      }
      const mapped = relToResolved.get(rel);
      if (mapped) {
        for (const resolvedPath of mapped) {
          ignoredSet.add(resolvedPath);
        }
      } else {
        ignoredSet.add(path.resolve(repoRoot, rel));
      }
    }
  }

  const kept = filePaths.filter((filePath) => !ignoredSet.has(path.resolve(filePath)));
  return {
    kept,
    ignoredCount: filePaths.length - kept.length,
    ...(failures.length > 0 ? { failures } : {}),
  };
}

/**
 * Collects staged, unstaged modified, and untracked non-ignored surviving
 * regular files within `cwd`.
 */
export async function getGitChangedFiles(
  cwd: string,
  options?: GitCommandOptions
): Promise<GitChangedFilesResult> {
  const probe = await probeGitRepository(cwd, options);
  if (probe.status !== 'repo') {
    return {
      isRepo: false,
      files: [],
      ...(probe.status === 'aborted' ? { aborted: true } : {}),
      ...(probe.status === 'error' ? { error: probe.error } : {}),
    };
  }

  const stagedArgs = ['diff', '--name-only', '--cached', '--diff-filter=ACMR', '-z', '--relative'];
  const workingArgs = ['ls-files', '--modified', '--others', '--exclude-standard', '-z'];
  const [stagedRes, workingRes] = await Promise.all([
    runGit(stagedArgs, cwd, options),
    runGit(workingArgs, cwd, options),
  ]);

  if (stagedRes.aborted || workingRes.aborted || options?.signal?.aborted) {
    return { isRepo: true, files: [], aborted: true };
  }
  if (stagedRes.spawnError || stagedRes.exitCode !== 0) {
    return {
      isRepo: true,
      files: [],
      error: buildCommandFailure('git-failed', stagedArgs, cwd, stagedRes),
    };
  }
  if (workingRes.spawnError || workingRes.exitCode !== 0) {
    return {
      isRepo: true,
      files: [],
      error: buildCommandFailure('git-failed', workingArgs, cwd, workingRes),
    };
  }

  return {
    isRepo: true,
    files: collectSurvivingFiles(cwd, [stagedRes.stdout, workingRes.stdout]),
  };
}

/**
 * Collects surviving regular files changed in commits between the merge base of
 * `baseRef` and `HEAD` within `cwd`, excluding uncommitted and untracked changes.
 */
export async function getGitBranchCommittedFiles(
  cwd: string,
  baseRef: string,
  options?: GitCommandOptions
): Promise<GitBranchCommittedFilesResult> {
  const trimmedRef = baseRef.trim();
  const probe = await probeGitRepository(cwd, options);
  if (probe.status !== 'repo') {
    return {
      isRepo: false,
      baseRef: trimmedRef,
      files: [],
      ...(probe.status === 'aborted' ? { aborted: true } : {}),
      ...(probe.status === 'error' ? { error: probe.error } : {}),
    };
  }

  const abort = (mergeBase?: string): GitBranchCommittedFilesResult => ({
    isRepo: true,
    baseRef: trimmedRef,
    files: [],
    aborted: true,
    ...(mergeBase ? { mergeBase } : {}),
  });
  const fail = (error: GitFailure, mergeBase?: string): GitBranchCommittedFilesResult => ({
    isRepo: true,
    baseRef: trimmedRef,
    files: [],
    error,
    ...(mergeBase ? { mergeBase } : {}),
  });

  if (!trimmedRef || trimmedRef.startsWith('-') || /[\0\r\n\t ]/.test(trimmedRef)) {
    return fail({
      code: 'invalid-ref',
      message: trimmedRef
        ? `Invalid Git base ref: ${trimmedRef}`
        : 'Base ref must be a non-empty Git reference.',
      cwd,
      command: 'git rev-parse --verify',
      exitCode: null,
    });
  }

  const headArgs = ['rev-parse', '--verify', 'HEAD^{commit}'];
  const baseArgs = ['rev-parse', '--verify', `${trimmedRef}^{commit}`];
  const [headRes, baseRes] = await Promise.all([
    runGit(headArgs, cwd, options),
    runGit(baseArgs, cwd, options),
  ]);

  if (headRes.aborted || baseRes.aborted || options?.signal?.aborted) {
    return abort();
  }
  if (headRes.spawnError || headRes.exitCode !== 0) {
    const isUnborn =
      !headRes.spawnError &&
      /Needed a single revision|Not a valid object name|unknown revision/i.test(
        headRes.stderr.toString('utf8')
      );
    return fail(
      buildCommandFailure(
        isUnborn ? 'unborn-head' : 'git-failed',
        headArgs,
        cwd,
        headRes,
        isUnborn ? 'Repository has no commits on HEAD yet.' : undefined
      )
    );
  }
  if (baseRes.spawnError || baseRes.exitCode !== 0) {
    return fail(
      buildCommandFailure(
        baseRes.spawnError ? 'git-failed' : 'invalid-ref',
        baseArgs,
        cwd,
        baseRes,
        `Base ref '${trimmedRef}' does not resolve to a commit.`
      )
    );
  }

  const headCommit = headRes.stdout.toString('utf8').trim();
  const baseCommit = baseRes.stdout.toString('utf8').trim();
  const mergeBaseArgs = ['merge-base', baseCommit, headCommit];
  const mergeBaseRes = await runGit(mergeBaseArgs, cwd, options);

  if (mergeBaseRes.aborted) {
    return abort();
  }
  if (mergeBaseRes.spawnError || mergeBaseRes.exitCode !== 0) {
    const code: GitFailureCode =
      !mergeBaseRes.spawnError && mergeBaseRes.exitCode === 1 ? 'no-merge-base' : 'git-failed';
    return fail(
      buildCommandFailure(
        code,
        mergeBaseArgs,
        cwd,
        mergeBaseRes,
        code === 'no-merge-base'
          ? `No common merge base between '${trimmedRef}' and HEAD.`
          : undefined
      )
    );
  }

  const mergeBase = mergeBaseRes.stdout.toString('utf8').trim();
  if (mergeBase === headCommit) {
    return { isRepo: true, baseRef: trimmedRef, mergeBase, files: [] };
  }

  const diffArgs = [
    'diff', '--name-only', '--diff-filter=ACMRT', '-z', '--relative', mergeBase, headCommit, '--',
  ];
  const diffRes = await runGit(diffArgs, cwd, options);
  if (diffRes.aborted) {
    return abort(mergeBase);
  }
  if (diffRes.spawnError || diffRes.exitCode !== 0) {
    return fail(buildCommandFailure('git-failed', diffArgs, cwd, diffRes), mergeBase);
  }

  return {
    isRepo: true,
    baseRef: trimmedRef,
    mergeBase,
    files: collectSurvivingFiles(cwd, [diffRes.stdout]),
  };
}

async function readGitmodulesPaths(repoDir: string): Promise<string[]> {
  let content: string;
  try {
    content = await fs.promises.readFile(path.join(repoDir, '.gitmodules'), 'utf8');
  } catch {
    return [];
  }

  const paths: string[] = [];
  let inSubmoduleSection = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    if (line.startsWith('[')) {
      inSubmoduleSection = /^\[submodule\b/i.test(line);
      continue;
    }
    const match = inSubmoduleSection ? /^path\s*=\s*(.+)$/i.exec(line) : null;
    if (!match) {
      continue;
    }
    const value = match[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    if (value && !path.isAbsolute(value)) {
      paths.push(value);
    }
  }
  return paths;
}

async function hasNoSymlinkSegmentsBetween(
  ancestorDir: string,
  targetDir: string
): Promise<boolean> {
  const rel = path.relative(ancestorDir, targetDir);
  if (rel === '') {
    return true;
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return false;
  }

  let current = ancestorDir;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function deduplicateDiscoveredRepositories(
  entries: readonly DiscoveredGitRepository[]
): DiscoveredGitRepository[] {
  const byCwd = new Map<string, { entry: DiscoveredGitRepository; cwdKey: string; topKey: string }>();
  for (const entry of entries) {
    const cwdKey = normalizePathKey(entry.cwd);
    if (!byCwd.has(cwdKey)) {
      byCwd.set(cwdKey, { entry, cwdKey, topKey: normalizePathKey(entry.topLevel) });
    }
  }

  const unique = Array.from(byCwd.values());
  // Drop redundant child scopes sharing the same top-level as an ancestor scope
  // while keeping sibling subfolders of the same repo and distinct nested repos.
  return unique
    .filter(
      (candidate) =>
        !unique.some(
          (other) =>
            other !== candidate &&
            other.topKey === candidate.topKey &&
            other.cwdKey !== candidate.cwdKey &&
            isWithinDirectory(other.cwdKey, candidate.cwdKey)
        )
    )
    .map(({ entry }) => entry)
    .sort((a, b) => a.cwd.localeCompare(b.cwd));
}

/**
 * Discovers Git repositories (workspace roots, enclosing parent repos, nested
 * repositories, submodules, linked worktrees, and explicit `knownRepoRoots`)
 * within `workspaceRoots`.
 */
export async function discoverGitRepositories(
  workspaceRoots: readonly string[],
  options?: DiscoverGitRepositoriesOptions
): Promise<DiscoverGitRepositoriesResult> {
  const signal = options?.signal;
  const maxDepth = Math.max(0, options?.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxDirectories = Math.max(1, options?.maxDirectories ?? DEFAULT_MAX_DIRECTORIES);

  const repositories: DiscoveredGitRepository[] = [];
  const errors: GitFailure[] = [];
  let truncated = false;

  const finalize = (aborted: boolean): DiscoverGitRepositoriesResult => ({
    repositories: deduplicateDiscoveredRepositories(repositories),
    errors,
    truncated,
    aborted,
  });

  if (signal?.aborted) {
    return finalize(true);
  }

  const normalizedRoots: string[] = [];
  const seenRootKeys = new Set<string>();
  for (const root of workspaceRoots) {
    const resolved = path.resolve(root);
    const key = normalizePathKey(resolved);
    if (!seenRootKeys.has(key)) {
      seenRootKeys.add(key);
      normalizedRoots.push(resolved);
    }
  }

  interface QueueItem {
    dir: string;
    workspaceRoot: string;
    depth: number;
    bypassDepthLimit: boolean;
  }

  const queue: QueueItem[] = [];
  const visitedDirKeys = new Set<string>();
  const candidates: Array<{ dir: string; workspaceRoot: string }> = [];
  const candidateKeys = new Set<string>();

  const enqueueDir = (item: QueueItem): void => {
    const key = normalizePathKey(item.dir);
    if (!visitedDirKeys.has(key)) {
      visitedDirKeys.add(key);
      queue.push(item);
    }
  };

  const enqueueSubmodules = async (
    gitmodulesOwnerDir: string,
    workspaceRoot: string,
    depth: number
  ): Promise<boolean> => {
    const wsCanonical = canonicalizePathSync(workspaceRoot);
    for (const relSubPath of await readGitmodulesPaths(gitmodulesOwnerDir)) {
      if (signal?.aborted) {
        return false;
      }
      const subAbsPath = path.resolve(gitmodulesOwnerDir, relSubPath);
      const scopedPath = isWithinDirectory(workspaceRoot, subAbsPath)
        ? subAbsPath
        : path.resolve(workspaceRoot, path.relative(wsCanonical, canonicalizePathSync(subAbsPath)));
      if (
        scopedPath === workspaceRoot ||
        !isWithinDirectory(workspaceRoot, scopedPath) ||
        !(await hasNoSymlinkSegmentsBetween(workspaceRoot, scopedPath))
      ) {
        continue;
      }
      enqueueDir({ dir: scopedPath, workspaceRoot, depth, bypassDepthLimit: true });
    }
    return true;
  };

  // Probe each workspace root directly first.
  for (const workspaceRoot of normalizedRoots) {
    if (signal?.aborted) {
      return finalize(true);
    }

    const probe = await probeGitRepository(workspaceRoot, options);
    if (probe.status === 'aborted') {
      return finalize(true);
    }
    if (probe.status === 'repo') {
      repositories.push({ cwd: workspaceRoot, topLevel: probe.topLevel, workspaceRoot });
      if (maxDepth > 0 && normalizePathKey(probe.topLevel) !== normalizePathKey(workspaceRoot)) {
        if (!(await enqueueSubmodules(probe.topLevel, workspaceRoot, 1))) {
          return finalize(true);
        }
      }
    } else if (probe.status === 'error') {
      errors.push(probe.error);
      if (probe.error.code === 'git-not-found') {
        return finalize(false);
      }
      if (probe.error.code === 'cwd-not-found') {
        continue;
      }
    }

    if (maxDepth > 0 && directoryExistsSync(workspaceRoot)) {
      enqueueDir({ dir: workspaceRoot, workspaceRoot, depth: 0, bypassDepthLimit: false });
    }
  }

  // Bounded, symlink-safe BFS for nested repositories, submodules, and linked worktrees.
  let inspectedDirectories = 0;
  for (let head = 0; head < queue.length; head++) {
    if (signal?.aborted) {
      return finalize(true);
    }
    if (inspectedDirectories >= maxDirectories) {
      truncated = true;
      break;
    }

    const item = queue[head];
    inspectedDirectories++;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    let hasGitMarker = false;
    let hasGitmodules = false;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.name === '.git' && (entry.isDirectory() || entry.isFile())) {
        hasGitMarker = true;
      } else if (entry.name === '.gitmodules' && entry.isFile()) {
        hasGitmodules = true;
      }
    }

    if (hasGitMarker && item.depth > 0) {
      const key = normalizePathKey(item.dir);
      if (!candidateKeys.has(key)) {
        candidateKeys.add(key);
        candidates.push({ dir: item.dir, workspaceRoot: item.workspaceRoot });
      }
    }

    if (hasGitmodules && !(await enqueueSubmodules(item.dir, item.workspaceRoot, item.depth + 1))) {
      return finalize(true);
    }

    if (!item.bypassDepthLimit && item.depth >= maxDepth) {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory() || DISCOVERY_PRUNE_DIRS.has(entry.name)) {
        continue;
      }
      enqueueDir({
        dir: path.join(item.dir, entry.name),
        workspaceRoot: item.workspaceRoot,
        depth: item.depth + 1,
        bypassDepthLimit: false,
      });
    }
  }

  // Merge caller-provided known repo roots (e.g. from VS Code's Git API) within workspace roots.
  for (const knownRoot of options?.knownRepoRoots ?? []) {
    const resolvedKnown = path.resolve(knownRoot);
    const knownKey = normalizePathKey(resolvedKnown);
    const containingRoot = normalizedRoots.find(
      (wsRoot) =>
        isWithinDirectory(wsRoot, resolvedKnown) ||
        isWithinDirectory(normalizePathKey(wsRoot), knownKey)
    );
    if (!containingRoot || knownKey === normalizePathKey(containingRoot)) {
      continue;
    }
    if (!candidateKeys.has(knownKey)) {
      candidateKeys.add(knownKey);
      candidates.push({ dir: resolvedKnown, workspaceRoot: containingRoot });
    }
  }

  // Validate discovered nested candidates to skip bogus `.git` entries and report real Git errors.
  for (const candidate of candidates) {
    if (signal?.aborted) {
      return finalize(true);
    }

    const probe = await probeGitRepository(candidate.dir, options);
    if (probe.status === 'aborted') {
      return finalize(true);
    }
    if (probe.status === 'error') {
      errors.push(probe.error);
      if (probe.error.code === 'git-not-found') {
        break;
      }
      continue;
    }
    if (
      probe.status === 'repo' &&
      normalizePathKey(probe.topLevel) === normalizePathKey(candidate.dir)
    ) {
      repositories.push({
        cwd: candidate.dir,
        topLevel: probe.topLevel,
        workspaceRoot: candidate.workspaceRoot,
      });
    }
  }

  return finalize(false);
}
