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
