import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  filterGitIgnoredFiles,
  getGitChangedFiles,
  isGitRepository,
} from '../src/git';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test('non-Git folder reports isRepo=false and filterGitIgnoredFiles keeps all files safely', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-non-git-'));
  try {
    const fileA = path.join(tmpDir, 'a.ts');
    const fileB = path.join(tmpDir, 'b.ts');
    fs.writeFileSync(fileA, 'export const a = 1;\n');
    fs.writeFileSync(fileB, 'export const b = 2;\n');

    assert.equal(await isGitRepository(tmpDir), false);
    assert.deepEqual(await filterGitIgnoredFiles(tmpDir, [fileA, fileB]), {
      kept: [fileA, fileB],
      ignoredCount: 0,
    });
    assert.deepEqual(await getGitChangedFiles(tmpDir), {
      isRepo: false,
      files: [],
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('filterGitIgnoredFiles skips .gitignore matches while keeping normal and force-tracked files', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-gitignore-'));
  try {
    git(tmpDir, 'init', '-q');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'ignored_dir/\n*.gen.ts\n');
    fs.mkdirSync(path.join(tmpDir, 'ignored_dir'));
    fs.mkdirSync(path.join(tmpDir, 'src'));

    const ignoredInDir = path.join(tmpDir, 'ignored_dir', 'a.ts');
    const ignoredByExt = path.join(tmpDir, 'src', 'b.gen.ts');
    const normalFile = path.join(tmpDir, 'src', 'c.ts');
    const trackedIgnoredFile = path.join(tmpDir, 'src', 'tracked.gen.ts');

    fs.writeFileSync(ignoredInDir, '');
    fs.writeFileSync(ignoredByExt, '');
    fs.writeFileSync(normalFile, '');
    fs.writeFileSync(trackedIgnoredFile, '');
    git(tmpDir, 'add', '-f', 'src/tracked.gen.ts');

    const result = await filterGitIgnoredFiles(tmpDir, [
      ignoredInDir,
      ignoredByExt,
      normalFile,
      trackedIgnoredFile,
    ]);

    assert.deepEqual(result, {
      kept: [normalFile, trackedIgnoredFile],
      ignoredCount: 2,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getGitChangedFiles returns staged, modified, and untracked files on unborn HEAD and committed repos', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-changed-'));
  try {
    git(tmpDir, 'init', '-q');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'dist/\n');
    fs.mkdirSync(path.join(tmpDir, 'apps/api/src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'apps/api/dist'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'apps/web/src'), { recursive: true });

    const stagedUnborn = path.join(tmpDir, 'apps/api/src/staged.ts');
    const untrackedUnborn = path.join(tmpDir, 'apps/api/src/untracked.ts');
    const cleanLater = path.join(tmpDir, 'apps/api/src/clean.ts');
    const toDelete = path.join(tmpDir, 'apps/api/src/deleted.ts');
    const ignoredOut = path.join(tmpDir, 'apps/api/dist/out.js');
    const webFile = path.join(tmpDir, 'apps/web/src/other.ts');

    fs.writeFileSync(stagedUnborn, 'export const a = 1;\n');
    fs.writeFileSync(untrackedUnborn, 'export const b = 1;\n');
    fs.writeFileSync(cleanLater, 'export const c = 1;\n');
    fs.writeFileSync(toDelete, 'export const d = 1;\n');
    fs.writeFileSync(ignoredOut, 'console.log(1);\n');
    fs.writeFileSync(webFile, 'export const w = 1;\n');

    git(tmpDir, 'add', 'apps/api/src/staged.ts');

    const unbornResult = await getGitChangedFiles(path.join(tmpDir, 'apps/api'));
    assert.deepEqual(unbornResult, {
      isRepo: true,
      files: [cleanLater, stagedUnborn, toDelete, untrackedUnborn].sort((a, b) =>
        a.localeCompare(b)
      ),
    });

    // Commit everything, then make targeted edits across states.
    git(tmpDir, 'add', '.');
    git(tmpDir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init');

    fs.writeFileSync(stagedUnborn, 'export const a = 2;\n'); // unstaged modification
    const newlyStaged = path.join(tmpDir, 'apps/api/src/new_staged.ts');
    fs.writeFileSync(newlyStaged, 'export const n = 1;\n');
    git(tmpDir, 'add', 'apps/api/src/new_staged.ts');

    fs.rmSync(toDelete); // deleted file must not be returned
    const freshUntracked = path.join(tmpDir, 'apps/api/src/fresh.ts');
    fs.writeFileSync(freshUntracked, 'export const f = 1;\n');
    fs.writeFileSync(webFile, 'export const w = 2;\n'); // outside apps/api

    const committedSubdir = await getGitChangedFiles(path.join(tmpDir, 'apps/api'));
    assert.deepEqual(committedSubdir, {
      isRepo: true,
      files: [freshUntracked, newlyStaged, stagedUnborn].sort((a, b) =>
        a.localeCompare(b)
      ),
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('filterGitIgnoredFiles handles a non-Git parent folder containing nested Git repos', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-nested-repos-'));
  try {
    const frontend = path.join(tmpDir, 'frontend');
    const backend = path.join(tmpDir, 'backend');
    const shared = path.join(tmpDir, 'shared');
    fs.mkdirSync(path.join(frontend, 'gen'), { recursive: true });
    fs.mkdirSync(path.join(backend, 'build'), { recursive: true });
    fs.mkdirSync(shared, { recursive: true });

    git(frontend, 'init', '-q');
    fs.writeFileSync(path.join(frontend, '.gitignore'), 'gen/\n');
    git(backend, 'init', '-q');
    fs.writeFileSync(path.join(backend, '.gitignore'), 'build/\n*.tmp.ts\n');

    const feIgnored = path.join(frontend, 'gen', 'types.ts');
    const feKept = path.join(frontend, 'index.ts');
    const beIgnoredDir = path.join(backend, 'build', 'app.ts');
    const beIgnoredExt = path.join(backend, 'scratch.tmp.ts');
    const beKept = path.join(backend, 'server.ts');
    const outsideFile = path.join(shared, 'util.ts');

    for (const file of [feIgnored, feKept, beIgnoredDir, beIgnoredExt, beKept, outsideFile]) {
      fs.writeFileSync(file, '');
    }

    const result = await filterGitIgnoredFiles(tmpDir, [
      feIgnored,
      feKept,
      beIgnoredDir,
      beIgnoredExt,
      beKept,
      outsideFile,
    ]);

    assert.deepEqual(result, {
      kept: [feKept, beKept, outsideFile],
      ignoredCount: 3,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('filterGitIgnoredFiles handles submodules without failing parent check-ignore', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-submodule-'));
  try {
    git(tmpDir, 'init', '-q');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '*.gen.ts\n');
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

    const sub = path.join(tmpDir, 'sub');
    fs.mkdirSync(path.join(sub, 'ignored'), { recursive: true });
    git(sub, 'init', '-q');
    fs.writeFileSync(path.join(sub, '.gitignore'), 'ignored/\n');
    fs.writeFileSync(path.join(sub, 'lib.ts'), 'export const lib = 1;\n');
    git(sub, 'add', 'lib.ts');
    git(
      sub,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '-m',
      'sub init'
    );
    // Register embedded repo as a gitlink (submodule entry) in the parent index.
    git(tmpDir, 'add', 'sub');

    const rootIgnored = path.join(tmpDir, 'src', 'schema.gen.ts');
    const rootKept = path.join(tmpDir, 'src', 'main.ts');
    const subIgnored = path.join(sub, 'ignored', 'helper.ts');
    const subKept = path.join(sub, 'lib.ts');

    fs.writeFileSync(rootIgnored, '');
    fs.writeFileSync(rootKept, '');
    fs.writeFileSync(subIgnored, '');

    const result = await filterGitIgnoredFiles(tmpDir, [
      rootIgnored,
      rootKept,
      subIgnored,
      subKept,
    ]);

    assert.deepEqual(result, {
      kept: [rootKept, subKept],
      ignoredCount: 2,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('filterGitIgnoredFiles respects parent repo .gitignore when cwd is a subdirectory', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-subdir-cwd-'));
  try {
    git(tmpDir, 'init', '-q');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '*.gen.ts\n');
    const webDir = path.join(tmpDir, 'apps', 'web');
    fs.mkdirSync(webDir, { recursive: true });

    const ignoredFile = path.join(webDir, 'api.gen.ts');
    const keptFile = path.join(webDir, 'app.ts');
    fs.writeFileSync(ignoredFile, '');
    fs.writeFileSync(keptFile, '');

    const result = await filterGitIgnoredFiles(webDir, [ignoredFile, keptFile]);
    assert.deepEqual(result, {
      kept: [keptFile],
      ignoredCount: 1,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
