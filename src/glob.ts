export const DEFAULT_INCLUDE_GLOB =
  '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py,pyi,go,java,kt,kts,cs,rs,dart,swift,php,rb,scala,vue,svelte,astro}';

export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/coverage/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/target/**',
  '**/vendor/**',
];

export type ActionMode = 'organizeImports' | 'sortImports' | 'removeUnusedImports';

export type OutputVerbosity = 'all' | 'changesOnly';

export interface ResolvedActionMode {
  mode: ActionMode;
  kindValue: string;
  label: string;
}

/**
 * Resolves the configured output verbosity to `'all'` or `'changesOnly'`.
 */
export function resolveOutputVerbosity(value: string | undefined): OutputVerbosity {
  return value === 'changesOnly' ? 'changesOnly' : 'all';
}

/**
 * Returns whether a per-file status line should be written for the given verbosity.
 */
export function shouldLogFileStatus(
  status: FileProcessStatus,
  verbosity: OutputVerbosity
): boolean {
  if (verbosity === 'all') {
    return true;
  }
  return status !== 'unchanged' && status !== 'no-action';
}

/**
 * Resolves the configured action mode to its VS Code CodeActionKind string.
 */
export function resolveActionKindValue(mode: string | undefined): ResolvedActionMode {
  switch (mode) {
    case 'sortImports':
      return {
        mode: 'sortImports',
        kindValue: 'source.sortImports',
        label: 'Sort Imports',
      };
    case 'removeUnusedImports':
      return {
        mode: 'removeUnusedImports',
        kindValue: 'source.removeUnusedImports',
        label: 'Remove Unused Imports',
      };
    default:
      return {
        mode: 'organizeImports',
        kindValue: 'source.organizeImports',
        label: 'Organize Imports',
      };
  }
}

/**
 * Extracts glob keys whose value is strictly `true`, ignoring `false` and
 * conditional `{ when: ... }` exclusion rules.
 */
export function extractEnabledExcludePatterns(
  setting: Record<string, unknown> | undefined
): string[] {
  if (!setting) {
    return [];
  }

  const patterns: string[] = [];
  for (const [pattern, enabled] of Object.entries(setting)) {
    if (enabled === true) {
      patterns.push(pattern);
    }
  }
  return patterns;
}

/**
 * Normalizes an exclude pattern and appends a recursive `/**` variant when
 * needed so folder excludes (like `node_modules`) also filter nested files.
 */
export function expandExcludePattern(pattern: string): string[] {
  const normalized = pattern.trim().replace(/\/+$/, '');
  if (!normalized) {
    return [];
  }

  if (normalized.endsWith('/**') || normalized.endsWith('/*')) {
    return [normalized];
  }

  return [normalized, `${normalized}/**`];
}

/**
 * Normalizes user-provided folder names or workspace-relative folder paths into
 * glob patterns suitable for VS Code's `findFiles` exclude parameter.
 */
export function normalizeIgnoredFolderPatterns(folders: readonly string[]): string[] {
  const patterns: string[] = [];

  for (const folder of folders) {
    const cleaned = folder.trim().replace(/\\/g, '/');
    const isRootAnchored = /^(\.\/|\/)/.test(cleaned);
    const normalized = cleaned.replace(/^(\.\/+|\/+)+/, '').replace(/\/+$/, '');

    if (!normalized || normalized === '.') {
      continue;
    }

    if (/[*?[\]{}]/.test(normalized)) {
      patterns.push(...expandExcludePattern(normalized));
      continue;
    }

    if (isRootAnchored || normalized.includes('/')) {
      patterns.push(normalized, `${normalized}/**`);
    } else {
      patterns.push(`**/${normalized}`, `**/${normalized}/**`);
    }
  }

  return patterns;
}

export interface BuildExcludeGlobOptions {
  customExcludes: readonly string[];
  ignoredFolders?: readonly string[];
  filesExclude?: Record<string, unknown>;
  searchExclude?: Record<string, unknown>;
  useWorkspaceExcludes: boolean;
}

/**
 * Returns `true` when an exclude setting contains conditional `{ when: ... }`
 * (or other non-boolean truthy) entries whose evaluation depends on sibling files.
 */
export function hasConditionalExcludeRules(
  setting: Record<string, unknown> | undefined
): boolean {
  if (!setting) {
    return false;
  }
  for (const value of Object.values(setting)) {
    if (value !== null && typeof value === 'object') {
      return true;
    }
  }
  return false;
}

/**
 * Collects deduplicated, expanded exclude glob patterns for the given options.
 */
export function collectExcludePatterns(options: BuildExcludeGlobOptions): string[] {
  const rawPatterns: string[] = [...options.customExcludes];
  const folderPatterns = normalizeIgnoredFolderPatterns(options.ignoredFolders ?? []);

  if (options.useWorkspaceExcludes) {
    rawPatterns.push(
      ...extractEnabledExcludePatterns(options.filesExclude),
      ...extractEnabledExcludePatterns(options.searchExclude)
    );
  }

  const uniquePatterns = new Set<string>();
  for (const rawPattern of rawPatterns) {
    for (const expanded of expandExcludePattern(rawPattern)) {
      uniquePatterns.add(expanded);
    }
  }
  for (const pattern of folderPatterns) {
    uniquePatterns.add(pattern);
  }

  return Array.from(uniquePatterns);
}

/**
 * Combines configured exclusions into a VS Code `findFiles` exclude glob.
 */
export function buildExcludeGlob(options: BuildExcludeGlobOptions): string | undefined {
  const patterns = collectExcludePatterns(options);
  if (patterns.length === 0) {
    return undefined;
  }
  if (patterns.length === 1) {
    return patterns[0];
  }
  return `{${patterns.join(',')}}`;
}

export type FileProcessStatus =
  | 'modified'
  | 'would-modify'
  | 'unchanged'
  | 'no-action'
  | 'command-only'
  | 'save-failed'
  | 'error';

export interface FormatFileStatusLineOptions {
  index: number;
  total: number;
  status: FileProcessStatus;
  relativePath: string;
  errorMessage?: string;
}

/**
 * Formats a single-line Output panel status entry for a processed file.
 */
export function formatFileStatusLine(options: FormatFileStatusLineOptions): string {
  const width = String(Math.max(1, options.total)).length;
  const paddedIndex = String(options.index).padStart(width, '0');
  const counter = `[${paddedIndex}/${options.total}]`;

  switch (options.status) {
    case 'modified':
      return `${counter} ✔ MODIFIED      ${options.relativePath}`;
    case 'would-modify':
      return `${counter} ~ WOULD MODIFY  ${options.relativePath}`;
    case 'unchanged':
      return `${counter} · UNCHANGED     ${options.relativePath}`;
    case 'no-action':
      return `${counter} ○ NO ACTION     ${options.relativePath}`;
    case 'command-only': {
      const sanitizedMsg = options.errorMessage?.replace(/\s+/g, ' ').trim();
      return `${counter} ▸ COMMAND ONLY  ${options.relativePath}${
        sanitizedMsg ? ` — ${sanitizedMsg}` : ''
      }`;
    }
    case 'save-failed': {
      const sanitizedMsg = options.errorMessage?.replace(/\s+/g, ' ').trim();
      return `${counter} ⚠ SAVE FAILED   ${options.relativePath}${
        sanitizedMsg ? ` — ${sanitizedMsg}` : ''
      }`;
    }
    case 'error': {
      const sanitizedMsg = options.errorMessage?.replace(/\s+/g, ' ').trim();
      return `${counter} ✖ ERROR         ${options.relativePath}${
        sanitizedMsg ? ` — ${sanitizedMsg}` : ''
      }`;
    }
  }
}

export interface OffsetTextEdit {
  startOffset: number;
  endOffset: number;
  newText: string;
}

/**
 * Applies non-overlapping offset-based edits in VS Code's tie-breaking order,
 * returning `null` if any range is out of bounds or overlaps a preceding edit.
 */
export function applyOffsetEdits(
  originalText: string,
  edits: readonly OffsetTextEdit[]
): string | null {
  if (edits.length === 0) {
    return originalText;
  }

  const ordered = edits
    .map((edit, idx) => ({ edit, idx }))
    .sort((a, b) => {
      if (a.edit.startOffset !== b.edit.startOffset) {
        return a.edit.startOffset - b.edit.startOffset;
      }
      if (a.edit.endOffset !== b.edit.endOffset) {
        return a.edit.endOffset - b.edit.endOffset;
      }
      return a.idx - b.idx;
    });

  let cursor = 0;
  const chunks: string[] = [];

  for (const { edit } of ordered) {
    if (
      edit.startOffset < 0 ||
      edit.endOffset < edit.startOffset ||
      edit.endOffset > originalText.length ||
      edit.startOffset < cursor
    ) {
      return null;
    }

    chunks.push(originalText.slice(cursor, edit.startOffset), edit.newText);
    cursor = edit.endOffset;
  }

  chunks.push(originalText.slice(cursor));
  return chunks.join('');
}

/**
 * Returns `true` when applying `edits` produces different text than `originalText`,
 * falling back conservatively to `true` when edits overlap.
 */
export function wouldOffsetEditsChangeText(
  originalText: string,
  edits: readonly OffsetTextEdit[]
): boolean {
  if (edits.length === 0) {
    return false;
  }
  const next = applyOffsetEdits(originalText, edits);
  if (next === null) {
    return true;
  }
  return next !== originalText;
}
