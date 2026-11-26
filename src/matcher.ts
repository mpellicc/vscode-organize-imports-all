import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildExcludeGlob,
  BuildExcludeGlobOptions,
  collectExcludePatterns,
  hasConditionalExcludeRules,
} from './glob';

const MAX_BRACE_DEPTH = 4;
const MAX_EXPANDED_PATTERNS = 64;

export interface CompileGlobOptions {
  caseSensitive?: boolean;
}

export type CompileGlobResult =
  | {
      supported: true;
      match: (relativePosixPath: string) => boolean;
      patterns: readonly string[];
    }
  | {
      supported: false;
      reason: string;
    };

function escapeRegExpChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Checks whether `pattern` contains balanced braces/brackets outside of
 * unsupported syntax and returns the index of the first brace group whose
 * contents include `/` or `**` (requiring pattern-level expansion).
 */
function findExpandableBraceGroup(
  pattern: string
):
  | { ok: true; group?: { start: number; end: number; alternatives: string[] } }
  | { ok: false; reason: string } {
  let depth = 0;
  let inCharClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (inCharClass) {
      if (ch === ']') {
        inCharClass = false;
      } else if (ch === '[' || ch === '{' || ch === '}' || ch === '/') {
        return { ok: false, reason: 'Unsupported character class syntax.' };
      }
      continue;
    }

    if (ch === '[') {
      inCharClass = true;
      continue;
    }
    if (ch === ']') {
      return { ok: false, reason: 'Unmatched closing bracket.' };
    }
    if (ch === '{') {
      depth++;
      if (depth > MAX_BRACE_DEPTH) {
        return { ok: false, reason: 'Brace nesting exceeds supported depth.' };
      }
      continue;
    }
    if (ch === '}') {
      if (depth === 0) {
        return { ok: false, reason: 'Unmatched closing brace.' };
      }
      depth--;
    }
  }

  if (inCharClass) {
    return { ok: false, reason: 'Unclosed character class.' };
  }
  if (depth !== 0) {
    return { ok: false, reason: 'Unclosed brace group.' };
  }

  // Locate the first brace group that contains `/` or `**`.
  inCharClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (inCharClass) {
      if (ch === ']') {
        inCharClass = false;
      }
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      continue;
    }
    if (ch !== '{') {
      continue;
    }

    let groupDepth = 1;
    let groupInCharClass = false;
    let end = -1;
    const alternatives: string[] = [];
    let altStart = i + 1;

    for (let j = i + 1; j < pattern.length; j++) {
      const c = pattern[j];
      if (groupInCharClass) {
        if (c === ']') {
          groupInCharClass = false;
        }
        continue;
      }
      if (c === '[') {
        groupInCharClass = true;
      } else if (c === '{') {
        groupDepth++;
      } else if (c === '}') {
        groupDepth--;
        if (groupDepth === 0) {
          alternatives.push(pattern.slice(altStart, j));
          end = j;
          break;
        }
      } else if (c === ',' && groupDepth === 1) {
        alternatives.push(pattern.slice(altStart, j));
        altStart = j + 1;
      }
    }

    if (end === -1) {
      return { ok: false, reason: 'Unclosed brace group.' };
    }
    if (alternatives.length < 2) {
      return { ok: false, reason: 'Brace group without comma alternatives is unsupported.' };
    }

    const inner = pattern.slice(i + 1, end);
    if (inner.includes('/') || inner.includes('**')) {
      return { ok: true, group: { start: i, end, alternatives } };
    }
  }

  return { ok: true };
}

function expandPathBraces(
  pattern: string
): { ok: true; expanded: string[] } | { ok: false; reason: string } {
  const queue: string[] = [pattern];
  const expanded: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const scan = findExpandableBraceGroup(current);
    if (!scan.ok) {
      return scan;
    }
    if (!scan.group) {
      expanded.push(current);
      if (expanded.length > MAX_EXPANDED_PATTERNS) {
        return { ok: false, reason: 'Brace expansion exceeds supported limit.' };
      }
      continue;
    }

    const prefix = current.slice(0, scan.group.start);
    const suffix = current.slice(scan.group.end + 1);
    if (expanded.length + queue.length + scan.group.alternatives.length > MAX_EXPANDED_PATTERNS) {
      return { ok: false, reason: 'Brace expansion exceeds supported limit.' };
    }

    for (const alt of scan.group.alternatives) {
      queue.push(`${prefix}${alt}${suffix}`);
    }
  }

  return { ok: true, expanded };
}

function compileSegment(
  segment: string
): { ok: true; regexSource: string } | { ok: false; reason: string } {
  if (segment.includes('**')) {
    return { ok: false, reason: 'Inline ** within a path segment is unsupported.' };
  }

  let out = '';
  let i = 0;

  while (i < segment.length) {
    const ch = segment[i];

    if (ch === '*') {
      out += '[^/]*';
      i++;
      continue;
    }

    if (ch === '?') {
      out += '[^/]';
      i++;
      continue;
    }

    if (ch === '[') {
      const closeIdx = segment.indexOf(']', i + 1);
      if (closeIdx === -1) {
        return { ok: false, reason: 'Unclosed character class.' };
      }
      let body = segment.slice(i + 1, closeIdx);
      if (!body) {
        return { ok: false, reason: 'Empty character class.' };
      }
      let negated = false;
      if (body[0] === '!' || body[0] === '^') {
        negated = true;
        body = body.slice(1);
        if (!body) {
          return { ok: false, reason: 'Empty negated character class.' };
        }
      }
      if (body.includes('[') || body.includes('/') || body.includes('\\')) {
        return { ok: false, reason: 'Unsupported character class contents.' };
      }
      let classBody = '';
      for (let k = 0; k < body.length; k++) {
        const c = body[k];
        if ((c === '^' && k === 0) || (c === '-' && (k === 0 || k === body.length - 1))) {
          classBody += `\\${c}`;
        } else {
          classBody += c;
        }
      }
      out += negated ? `[^/${classBody}]` : `[${classBody}]`;
      i = closeIdx + 1;
      continue;
    }

    if (ch === '{') {
      let depth = 1;
      let inClass = false;
      let end = -1;
      const alts: string[] = [];
      let altStart = i + 1;

      for (let j = i + 1; j < segment.length; j++) {
        const c = segment[j];
        if (inClass) {
          if (c === ']') {
            inClass = false;
          }
          continue;
        }
        if (c === '[') {
          inClass = true;
        } else if (c === '{') {
          depth++;
        } else if (c === '}') {
          depth--;
          if (depth === 0) {
            alts.push(segment.slice(altStart, j));
            end = j;
            break;
          }
        } else if (c === ',' && depth === 1) {
          alts.push(segment.slice(altStart, j));
          altStart = j + 1;
        }
      }

      if (end === -1) {
        return { ok: false, reason: 'Unclosed brace group.' };
      }
      if (alts.length < 2) {
        return { ok: false, reason: 'Brace group without comma alternatives is unsupported.' };
      }

      const compiledAlts: string[] = [];
      for (const alt of alts) {
        const res = compileSegment(alt);
        if (!res.ok) {
          return res;
        }
        compiledAlts.push(res.regexSource);
      }
      out += `(?:${compiledAlts.join('|')})`;
      i = end + 1;
      continue;
    }

    if (ch === '}' || ch === ']') {
      return { ok: false, reason: `Unexpected '${ch}' in glob segment.` };
    }

    out += escapeRegExpChar(ch);
    i++;
  }

  return { ok: true, regexSource: out };
}

function compileSingleExpandedPattern(
  pattern: string,
  caseSensitive: boolean
): { ok: true; regex: RegExp } | { ok: false; reason: string } {
  if (
    !pattern ||
    pattern.startsWith('/') ||
    pattern.endsWith('/') ||
    pattern.includes('//') ||
    pattern === '.' ||
    pattern === '..' ||
    pattern.startsWith('./') ||
    pattern.startsWith('../') ||
    pattern.includes('/./') ||
    pattern.includes('/../') ||
    pattern.endsWith('/.') ||
    pattern.endsWith('/..')
  ) {
    return { ok: false, reason: 'Path anchor or dot-segment syntax requires native matching.' };
  }

  const rawSegments = pattern.split('/');
  const segments: string[] = [];
  for (const seg of rawSegments) {
    if (seg === '**' && segments[segments.length - 1] === '**') {
      continue;
    }
    segments.push(seg);
  }

  if (segments.length === 1 && segments[0] === '**') {
    return { ok: true, regex: new RegExp('^.*$', caseSensitive ? '' : 'i') };
  }

  let source = '^';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isFirst = i === 0;
    const isLast = i === segments.length - 1;
    const prevWasGlobstar = i > 0 && segments[i - 1] === '**';

    if (seg === '**') {
      if (isFirst) {
        source += '(?:.+/)?';
      } else if (isLast) {
        source += '/.*';
      } else {
        source += '/(?:.+/)?';
      }
      continue;
    }

    const compiled = compileSegment(seg);
    if (!compiled.ok) {
      return compiled;
    }

    if (!isFirst && !prevWasGlobstar) {
      source += '/';
    }
    source += compiled.regexSource;
  }

  source += '$';

  try {
    return { ok: true, regex: new RegExp(source, caseSensitive ? '' : 'i') };
  } catch {
    return { ok: false, reason: 'Failed to compile glob regular expression.' };
  }
}

/**
 * Compiles a supported workspace-relative glob pattern into a deterministic
 * matcher. Returns `{ supported: false }` when parity with VS Code's native
 * matching cannot be guaranteed.
 */
export function compileGlobPattern(
  rawPattern: string,
  options?: CompileGlobOptions
): CompileGlobResult {
  const pattern = rawPattern.trim();
  if (!pattern) {
    return { supported: true, match: () => false, patterns: [] };
  }

  if (pattern.startsWith('!')) {
    return { supported: false, reason: 'Negated glob pattern requires native matching.' };
  }
  if (pattern.includes('\\')) {
    return { supported: false, reason: 'Backslash in glob pattern requires native matching.' };
  }
  if (/[@+*?!]\(/.test(pattern)) {
    return { supported: false, reason: 'Extglob syntax requires native matching.' };
  }

  const expanded = expandPathBraces(pattern);
  if (!expanded.ok) {
    return { supported: false, reason: expanded.reason };
  }

  const caseSensitive = options?.caseSensitive ?? process.platform !== 'win32';
  const regexes: RegExp[] = [];
  for (const candidate of expanded.expanded) {
    const compiled = compileSingleExpandedPattern(candidate, caseSensitive);
    if (!compiled.ok) {
      return { supported: false, reason: compiled.reason };
    }
    regexes.push(compiled.regex);
  }

  return {
    supported: true,
    patterns: expanded.expanded,
    match: (relativePosixPath: string): boolean => {
      if (!relativePosixPath) {
        return false;
      }
      for (const regex of regexes) {
        if (regex.test(relativePosixPath)) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * Compiles a list of workspace-relative glob patterns into a single matcher.
 * Fails over to `{ supported: false }` if any individual pattern is unsupported.
 */
export function compileGlobPatterns(
  patterns: readonly string[],
  options?: CompileGlobOptions
): CompileGlobResult {
  const matchers: Array<(relativePosixPath: string) => boolean> = [];
  const allExpanded: string[] = [];

  for (const pattern of patterns) {
    const compiled = compileGlobPattern(pattern, options);
    if (!compiled.supported) {
      return compiled;
    }
    if (compiled.patterns.length > 0) {
      matchers.push(compiled.match);
      allExpanded.push(...compiled.patterns);
    }
  }

  return {
    supported: true,
    patterns: allExpanded,
    match: (relativePosixPath: string): boolean => {
      for (const fn of matchers) {
        if (fn(relativePosixPath)) {
          return true;
        }
      }
      return false;
    },
  };
}

export interface CandidateFilterOptions extends BuildExcludeGlobOptions {
  includeGlob: string;
  caseSensitive?: boolean;
}

export interface CandidateFilter {
  /** True when both include and effective excludes can be evaluated without `findFiles`. */
  canMatchAllNatively: boolean;
  /** Human-readable reason why native `findFiles` fallback is required, if any. */
  fallbackReason?: string;
  /** Evaluates a workspace-relative POSIX path against include and effective excludes. */
  matchesCandidate: (relativePosixPath: string) => boolean;
  /** True when custom-only excludes (`exclude` + `ignoredFolders`) can be evaluated directly. */
  canMatchCustomExcludesNatively: boolean;
  /** Evaluates a workspace-relative POSIX path against custom-only excludes. */
  matchesCustomExclude: (relativePosixPath: string) => boolean;
  /** Combined exclude glob suitable for VS Code `findFiles` when `useWorkspaceExcludes` is true. */
  effectiveExcludeGlob: string | undefined;
  /** Custom-only exclude glob (`exclude` + `ignoredFolders`). */
  customExcludeGlob: string | undefined;
}

/**
 * Builds a per-root candidate filter that supports deterministic in-memory
 * matching for standard patterns and signals when VS Code's native `findFiles`
 * fallback must be used to guarantee parity.
 */
export function createCandidateFilter(options: CandidateFilterOptions): CandidateFilter {
  const compileOpts: CompileGlobOptions = {
    caseSensitive: options.caseSensitive ?? process.platform !== 'win32',
  };

  const effectiveExcludeGlob = buildExcludeGlob(options);
  const customOnlyOptions: BuildExcludeGlobOptions = {
    customExcludes: options.customExcludes,
    ignoredFolders: options.ignoredFolders,
    useWorkspaceExcludes: false,
  };
  const customExcludeGlob = buildExcludeGlob(customOnlyOptions);

  const customPatterns = collectExcludePatterns(customOnlyOptions);
  const compiledCustomExcludes = compileGlobPatterns(customPatterns, compileOpts);

  const compiledInclude = compileGlobPattern(options.includeGlob, compileOpts);

  let effectiveExcludeCompiled: CompileGlobResult;
  if (options.useWorkspaceExcludes) {
    if (hasConditionalExcludeRules(options.filesExclude)) {
      effectiveExcludeCompiled = {
        supported: false,
        reason: 'files.exclude contains conditional { when } rules requiring native matching.',
      };
    } else {
      const effectivePatterns = collectExcludePatterns(options);
      effectiveExcludeCompiled = compileGlobPatterns(effectivePatterns, compileOpts);
    }
  } else {
    effectiveExcludeCompiled = compiledCustomExcludes;
  }

  const canMatchAllNatively = compiledInclude.supported && effectiveExcludeCompiled.supported;
  const fallbackReason = !compiledInclude.supported
    ? compiledInclude.reason
    : !effectiveExcludeCompiled.supported
      ? effectiveExcludeCompiled.reason
      : undefined;

  return {
    canMatchAllNatively,
    fallbackReason,
    matchesCandidate: (relativePosixPath: string): boolean => {
      if (!compiledInclude.supported || !effectiveExcludeCompiled.supported) {
        return false;
      }
      return (
        compiledInclude.match(relativePosixPath) &&
        !effectiveExcludeCompiled.match(relativePosixPath)
      );
    },
    canMatchCustomExcludesNatively: compiledCustomExcludes.supported,
    matchesCustomExclude: (relativePosixPath: string): boolean => {
      if (!compiledCustomExcludes.supported) {
        return false;
      }
      return compiledCustomExcludes.match(relativePosixPath);
    },
    effectiveExcludeGlob,
    customExcludeGlob,
  };
}

function tryRealpathSync(targetPath: string): string | null {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

/**
 * Returns a normalized deduplication key for a local filesystem path,
 * resolving symlinks when possible and folding case on Windows.
 */
export function getCanonicalPathKey(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const canonical = tryRealpathSync(resolved) ?? resolved;
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * Checks whether `candidatePath` is inside (or equal to) `parentDir` using
 * lexical resolution, without following symlinks.
 */
export function isPathWithinDirectory(parentDir: string, candidatePath: string): boolean {
  const rel = path.relative(parentDir, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Computes a POSIX-style relative path from `baseDir` to `targetPath`,
 * falling back to realpath canonicalization when symlinked prefixes differ
 * (e.g. `/var` vs `/private/var` on macOS). Returns `null` when outside `baseDir`
 * or equal to `baseDir`.
 */
export function toPosixRelativePath(baseDir: string, targetPath: string): string | null {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);

  let rel = path.relative(resolvedBase, resolvedTarget);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    const realBase = tryRealpathSync(resolvedBase);
    const realTarget = tryRealpathSync(resolvedTarget);
    if (realBase && realTarget) {
      rel = path.relative(realBase, realTarget);
    }
  }

  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }

  return rel.split(path.sep).join('/');
}
