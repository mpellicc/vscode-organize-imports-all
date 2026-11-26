import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOffsetEdits,
  buildExcludeGlob,
  expandExcludePattern,
  extractEnabledExcludePatterns,
  formatFileStatusLine,
  normalizeIgnoredFolderPatterns,
  resolveActionKindValue,
  wouldOffsetEditsChangeText,
} from '../src/glob';

test('extractEnabledExcludePatterns keeps only entries strictly equal to true', () => {
  assert.deepEqual(extractEnabledExcludePatterns(undefined), []);

  const result = extractEnabledExcludePatterns({
    '**/.git': true,
    '**/.DS_Store': true,
    '**/keep-visible': false,
    '**/*.js': { when: '$(basename).ts' },
    '**/nested': { when: 'other' },
  });

  assert.deepEqual(result, ['**/.git', '**/.DS_Store']);
});

test('expandExcludePattern handles folder patterns, trailing slashes, and wildcard suffixes', () => {
  assert.deepEqual(expandExcludePattern('   '), []);
  assert.deepEqual(expandExcludePattern('/'), []);
  assert.deepEqual(expandExcludePattern('**/node_modules'), [
    '**/node_modules',
    '**/node_modules/**',
  ]);
  assert.deepEqual(expandExcludePattern('**/node_modules/'), [
    '**/node_modules',
    '**/node_modules/**',
  ]);
  assert.deepEqual(expandExcludePattern('**/dist/**'), ['**/dist/**']);
  assert.deepEqual(expandExcludePattern('**/tmp/*'), ['**/tmp/*']);
});

test('buildExcludeGlob returns undefined when no excludes are enabled', () => {
  const result = buildExcludeGlob({
    customExcludes: [],
    filesExclude: { '**/a': false },
    searchExclude: { '**/*.js': { when: '$(basename).ts' } },
    useWorkspaceExcludes: true,
  });

  assert.equal(result, undefined);
});

test('buildExcludeGlob does not wrap a single pattern in braces', () => {
  const result = buildExcludeGlob({
    customExcludes: ['**/dist/**'],
    filesExclude: { '**/ignored': true },
    useWorkspaceExcludes: false,
  });

  assert.equal(result, '**/dist/**');
});

test('buildExcludeGlob wraps multiple patterns in braces and deduplicates', () => {
  const result = buildExcludeGlob({
    customExcludes: ['**/dist/**', '**/node_modules/**'],
    filesExclude: {
      '**/.git': true,
      '**/dist/**': true,
      '**/*.js': { when: '$(basename).ts' },
    },
    searchExclude: {
      '**/node_modules': true,
      '**/build': false,
    },
    useWorkspaceExcludes: true,
  });

  assert.equal(
    result,
    '{**/dist/**,**/node_modules/**,**/.git,**/.git/**,**/node_modules}'
  );
});

test('normalizeIgnoredFolderPatterns supports bare folder names, relative paths, prefixes, and globs', () => {
  assert.deepEqual(
    normalizeIgnoredFolderPatterns([
      '',
      '  ',
      '/',
      '.',
      './',
      'generated',
      'src/legacy/',
      './build',
      '/tmp',
      'packages\\api\\dist',
      'apps/*/generated',
    ]),
    [
      '**/generated',
      '**/generated/**',
      'src/legacy',
      'src/legacy/**',
      'build',
      'build/**',
      'tmp',
      'tmp/**',
      'packages/api/dist',
      'packages/api/dist/**',
      'apps/*/generated',
      'apps/*/generated/**',
    ]
  );
});

test('buildExcludeGlob merges ignoredFolders on top of existing excludes', () => {
  const result = buildExcludeGlob({
    customExcludes: ['**/dist/**'],
    ignoredFolders: ['generated', 'src/legacy'],
    useWorkspaceExcludes: false,
  });

  assert.equal(
    result,
    '{**/dist/**,**/generated,**/generated/**,src/legacy,src/legacy/**}'
  );
});

test('formatFileStatusLine renders aligned single-line statuses and collapses multi-line errors', () => {
  assert.equal(
    formatFileStatusLine({
      index: 1,
      total: 42,
      status: 'modified',
      relativePath: 'src/index.ts',
    }),
    '[01/42] ✔ MODIFIED      src/index.ts'
  );

  assert.equal(
    formatFileStatusLine({
      index: 2,
      total: 42,
      status: 'would-modify',
      relativePath: 'src/preview.ts',
    }),
    '[02/42] ~ WOULD MODIFY  src/preview.ts'
  );

  assert.equal(
    formatFileStatusLine({
      index: 3,
      total: 42,
      status: 'unchanged',
      relativePath: 'src/app.ts',
    }),
    '[03/42] · UNCHANGED     src/app.ts'
  );

  assert.equal(
    formatFileStatusLine({
      index: 4,
      total: 42,
      status: 'error',
      relativePath: 'src/broken.ts',
      errorMessage: 'Failed to parse\n  unexpected token\tnear EOF',
    }),
    '[04/42] ✖ ERROR         src/broken.ts — Failed to parse unexpected token near EOF'
  );
});

test('resolveActionKindValue maps known action modes and falls back to organizeImports', () => {
  assert.deepEqual(resolveActionKindValue(undefined), {
    mode: 'organizeImports',
    kindValue: 'source.organizeImports',
    label: 'Organize Imports',
  });

  assert.deepEqual(resolveActionKindValue('sortImports'), {
    mode: 'sortImports',
    kindValue: 'source.sortImports',
    label: 'Sort Imports',
  });

  assert.deepEqual(resolveActionKindValue('removeUnusedImports'), {
    mode: 'removeUnusedImports',
    kindValue: 'source.removeUnusedImports',
    label: 'Remove Unused Imports',
  });

  assert.deepEqual(resolveActionKindValue('unknownValue'), {
    mode: 'organizeImports',
    kindValue: 'source.organizeImports',
    label: 'Organize Imports',
  });
});

test('applyOffsetEdits and wouldOffsetEditsChangeText handle no-ops, split delete+insert pairs, ordering, and overlaps', () => {
  const sample = "import { a } from './a';\nimport { b } from './b';\n\nconsole.log(a, b);\n";

  assert.equal(wouldOffsetEditsChangeText(sample, []), false);

  assert.equal(
    wouldOffsetEditsChangeText(sample, [
      { startOffset: 0, endOffset: 24, newText: "import { a } from './a';" },
    ]),
    false
  );

  // Split [delete, insert] pair reconstructing the exact same text (in both orders)
  const importsBlock = "import { a } from './a';\nimport { b } from './b';\n";
  const blockLen = importsBlock.length;
  assert.equal(
    wouldOffsetEditsChangeText(sample, [
      { startOffset: 0, endOffset: blockLen, newText: '' },
      { startOffset: 0, endOffset: 0, newText: importsBlock },
    ]),
    false
  );
  assert.equal(
    wouldOffsetEditsChangeText(sample, [
      { startOffset: 0, endOffset: 0, newText: importsBlock },
      { startOffset: 0, endOffset: blockLen, newText: '' },
    ]),
    false
  );

  // Multiple zero-width inserts at offset 0 preserve input array order
  assert.equal(
    applyOffsetEdits('world', [
      { startOffset: 0, endOffset: 0, newText: 'hello ' },
      { startOffset: 0, endOffset: 0, newText: 'brave ' },
    ]),
    'hello brave world'
  );

  // Real import reorder changes text
  const reordered = "import { b } from './b';\nimport { a } from './a';\n";
  assert.equal(
    wouldOffsetEditsChangeText(sample, [
      { startOffset: 0, endOffset: blockLen, newText: reordered },
    ]),
    true
  );
  assert.equal(
    applyOffsetEdits(sample, [{ startOffset: 0, endOffset: blockLen, newText: reordered }]),
    `${reordered}\nconsole.log(a, b);\n`
  );

  // Unused import deletion changes text
  assert.equal(
    wouldOffsetEditsChangeText(sample, [
      { startOffset: 0, endOffset: 25, newText: '' },
    ]),
    true
  );

  // Overlapping ranges return null and conservatively report a change
  assert.equal(
    applyOffsetEdits('abcdef', [
      { startOffset: 1, endOffset: 4, newText: 'X' },
      { startOffset: 2, endOffset: 5, newText: 'Y' },
    ]),
    null
  );
  assert.equal(
    wouldOffsetEditsChangeText('abcdef', [
      { startOffset: 1, endOffset: 4, newText: 'X' },
      { startOffset: 2, endOffset: 5, newText: 'Y' },
    ]),
    true
  );
});
