import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import {
  discoverGitRepositories,
  filterGitIgnoredFiles,
  getGitBranchCommittedFiles,
  getGitChangedFiles,
  GitFailure,
} from './git';
import {
  ActionMode,
  applyOffsetEdits,
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_INCLUDE_GLOB,
  formatFileStatusLine,
  OffsetTextEdit,
  OutputVerbosity,
  resolveActionKindValue,
  resolveOutputVerbosity,
  shouldLogFileStatus,
  wouldOffsetEditsChangeText,
} from './glob';
import {
  CandidateFilter,
  createCandidateFilter,
  getCanonicalPathKey,
  toPosixRelativePath,
} from './matcher';

const ITEM_RESOLVE_COUNT = 10;
const COLD_START_DELAYS_MS = [250, 500, 1000] as const;
const EMPTY_RETRY_CACHE_TTL_MS = 60_000;
const EMPTY_RETRY_CACHE_MAX_DOCS = 64;
const EMPTY_RETRY_CACHE_MAX_KINDS_PER_DOC = 8;

type CodeActionResult = vscode.CodeAction | vscode.Command;

interface ExhaustedEmptyRetryEntry {
  version: number;
  languageId: string;
  eol: vscode.EndOfLine;
  extensionsSignature: string;
  expiresAt: number;
}

interface ExhaustedEmptyRetryDocBucket {
  ref: WeakRef<vscode.TextDocument>;
  entries: Map<string, ExhaustedEmptyRetryEntry>;
}

const exhaustedEmptyRetryCache = new WeakMap<
  vscode.TextDocument,
  ExhaustedEmptyRetryDocBucket
>();
const exhaustedEmptyRetryDocRefs = new Set<WeakRef<vscode.TextDocument>>();

export type OrganizeScope =
  | { kind: 'workspace' }
  | { kind: 'folders'; folders: readonly vscode.Uri[] }
  | { kind: 'files'; files: readonly vscode.Uri[]; folders?: readonly vscode.Uri[] }
  | { kind: 'gitChanged' }
  | { kind: 'gitBranch'; baseRef: string };

export interface RunOrganizeOptions {
  scope: OrganizeScope;
  dryRun?: boolean;
  actionMode?: ActionMode;
}

export interface DocumentBaseline {
  uri: vscode.Uri;
  version: number;
  text: string;
  eol: vscode.EndOfLine;
  wasDirty: boolean;
  /** Live TextDocument reference captured at scan time to detect close/reopen. */
  document?: vscode.TextDocument;
}

export interface PreviewTextEditEntry {
  uri: vscode.Uri;
  edits: vscode.TextEdit[];
  baseline?: DocumentBaseline;
}

export type OrganizeDocumentOutcome =
  | 'modified'
  | 'would-modify'
  | 'unchanged'
  | 'no-action'
  | 'command-only'
  | 'save-failed'
  | 'error';

export interface DocumentPhaseTimings {
  openMs: number;
  providerMs: number;
  retryWaitMs: number;
  retryCount: number;
  applyMs: number;
  saveMs: number;
}

export interface PhaseTimings extends DocumentPhaseTimings {
  discoveryMs: number;
  gitMs: number;
}

export interface OrganizeDocumentResult {
  modified: boolean;
  languageId: string;
  wasDirty: boolean;
  leftUnsaved: boolean;
  previewEdits: PreviewTextEditEntry[];
  outcome: OrganizeDocumentOutcome;
  saveFailed?: boolean;
  cancelled?: boolean;
  errorMessage?: string;
  timings?: DocumentPhaseTimings;
}

interface DocumentSnapshot {
  version: number;
  text: string;
  eol: vscode.EndOfLine;
}

interface ProposedEditSpec {
  startOffset: number;
  endOffset: number;
  rawNewText: string;
  normalizedNewText: string;
}

interface ProposedEditExpectation {
  effectiveEol: vscode.EndOfLine;
  proposedSpecs: ProposedEditSpec[];
  expectedNormalizedText: string | null;
  expectedRawText: string | null;
}

interface TargetChangeTracker {
  textChangeEvents: number;
  allEventsMatchedProposed: boolean;
  matchedAnyProposed: boolean;
  lastEventHadUndoOrRedo: boolean;
}

function isMultiRootWorkspace(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
}

function formatDisplayPath(target: vscode.Uri | string): string {
  return vscode.workspace.asRelativePath(target, isMultiRootWorkspace());
}

function formatDurationMs(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${Math.round(ms)}ms`;
}

function formatPhaseTimingsNote(timings: PhaseTimings, dryRun: boolean): string {
  const parts: string[] = [
    `discovery ${formatDurationMs(timings.discoveryMs)} (git ${formatDurationMs(timings.gitMs)})`,
    `open ${formatDurationMs(timings.openMs)}`,
    `provider ${formatDurationMs(timings.providerMs)} (retries ${formatDurationMs(timings.retryWaitMs)} / ${timings.retryCount})`,
  ];
  if (!dryRun) {
    parts.push(`apply ${formatDurationMs(timings.applyMs)}`);
    parts.push(`save ${formatDurationMs(timings.saveMs)}`);
  }
  return `ℹ Note: Timings — ${parts.join(', ')}`;
}

function createAbortControllerForToken(token: vscode.CancellationToken): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
    return { signal: controller.signal, dispose: () => {} };
  }
  const subscription =
    typeof token.onCancellationRequested === 'function'
      ? token.onCancellationRequested(() => controller.abort())
      : undefined;
  return {
    signal: controller.signal,
    dispose: () => {
      subscription?.dispose();
    },
  };
}

function getUriDedupKey(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? getCanonicalPathKey(uri.fsPath) : uri.toString();
}

function toRelativePosixForUri(baseUri: vscode.Uri, targetUri: vscode.Uri): string | null {
  if (baseUri.scheme === 'file' && targetUri.scheme === 'file') {
    return toPosixRelativePath(baseUri.fsPath, targetUri.fsPath);
  }
  if (baseUri.scheme !== targetUri.scheme || baseUri.authority !== targetUri.authority) {
    return null;
  }
  const rel = path.posix.relative(baseUri.path, targetUri.path);
  if (!rel || rel.startsWith('..') || path.posix.isAbsolute(rel)) {
    return null;
  }
  return rel;
}

function findOwningWorkspaceFolder(
  uri: vscode.Uri,
  workspaceFolders: readonly vscode.WorkspaceFolder[]
): vscode.WorkspaceFolder | undefined {
  const direct = vscode.workspace.getWorkspaceFolder(uri);
  if (direct) {
    return direct;
  }

  let best: vscode.WorkspaceFolder | undefined;
  let bestLen = -1;
  for (const wf of workspaceFolders) {
    const rel = toRelativePosixForUri(wf.uri, uri);
    if (rel !== null) {
      const len = wf.uri.scheme === 'file' ? wf.uri.fsPath.length : wf.uri.path.length;
      if (len > bestLen) {
        best = wf;
        bestLen = len;
      }
    }
  }
  return best;
}

function resolveGitPathToWorkspaceUri(
  absPath: string,
  workspaceFolders: readonly vscode.WorkspaceFolder[]
): { uri: vscode.Uri; workspaceFolder: vscode.WorkspaceFolder; relativePosix: string } | undefined {
  let bestMatch:
    | { uri: vscode.Uri; workspaceFolder: vscode.WorkspaceFolder; relativePosix: string; rootLen: number }
    | undefined;

  for (const wf of workspaceFolders) {
    if (wf.uri.scheme !== 'file') {
      continue;
    }
    const relPosix = toPosixRelativePath(wf.uri.fsPath, absPath);
    if (!relPosix) {
      continue;
    }
    const rootLen = wf.uri.fsPath.length;
    if (!bestMatch || rootLen > bestMatch.rootLen) {
      const relNative = relPosix.split('/').join(path.sep);
      bestMatch = {
        uri: vscode.Uri.file(path.join(wf.uri.fsPath, relNative)),
        workspaceFolder: wf,
        relativePosix: relPosix,
        rootLen,
      };
    }
  }

  if (!bestMatch) {
    return undefined;
  }

  return {
    uri: bestMatch.uri,
    workspaceFolder: bestMatch.workspaceFolder,
    relativePosix: bestMatch.relativePosix,
  };
}

function getKnownGitExtensionRepoRoots(): string[] {
  try {
    const ext = vscode.extensions?.getExtension<{
      getAPI?: (version: number) => {
        repositories?: ReadonlyArray<{ rootUri?: vscode.Uri }>;
      };
    }>('vscode.git');
    if (!ext?.isActive || typeof ext.exports?.getAPI !== 'function') {
      return [];
    }
    const api = ext.exports.getAPI(1);
    const roots: string[] = [];
    for (const repo of api?.repositories ?? []) {
      if (repo?.rootUri?.scheme === 'file' && repo.rootUri.fsPath) {
        roots.push(repo.rootUri.fsPath);
      }
    }
    return roots;
  } catch {
    return [];
  }
}

function formatGitFailure(failure: GitFailure): string {
  const location = failure.cwd ? formatDisplayPath(failure.cwd) : '';
  const prefix = location ? `[${location}] ` : '';
  switch (failure.code) {
    case 'git-not-found':
      return 'Git executable was not found in PATH.';
    case 'cwd-not-found':
      return `${prefix}Directory does not exist.`;
    case 'unborn-head':
      return `${prefix}Repository has no commits on HEAD yet.`;
    case 'invalid-ref':
    case 'no-merge-base':
      return `${prefix}${failure.message}`;
    case 'git-failed':
      return `${prefix}${failure.command} failed: ${failure.message}`;
  }
}

function isTextDocument(target: vscode.TextDocument | vscode.Uri): target is vscode.TextDocument {
  return (
    typeof target === 'object' &&
    target !== null &&
    'getText' in target &&
    typeof target.getText === 'function'
  );
}

function isCommandItem(item: CodeActionResult): item is vscode.Command {
  return 'command' in item && typeof item.command === 'string';
}

function isMatchingActionKind(
  action: vscode.CodeAction,
  targetKind: vscode.CodeActionKind
): boolean {
  if (!action.kind) {
    return true;
  }
  return targetKind.contains(action.kind);
}

function isCrlfEol(eol: vscode.EndOfLine): boolean {
  const crlfValue = vscode.EndOfLine?.CRLF ?? 2;
  return eol === crlfValue;
}

function normalizeTextForEol(text: string, eol: vscode.EndOfLine): string {
  return isCrlfEol(eol) ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
}

function computeEffectiveEol(
  baseEol: vscode.EndOfLine,
  edits: readonly vscode.TextEdit[]
): vscode.EndOfLine {
  let eol = baseEol;
  for (const te of edits) {
    if (te.newEol !== undefined) {
      eol = te.newEol;
    }
  }
  return eol;
}

function captureSnapshot(doc: vscode.TextDocument): DocumentSnapshot {
  return {
    version: doc.version,
    text: doc.getText(),
    eol: doc.eol,
  };
}

function isDocumentStale(doc: vscode.TextDocument, snapshot: DocumentSnapshot): boolean {
  return (
    doc.isClosed ||
    doc.version !== snapshot.version ||
    doc.getText() !== snapshot.text ||
    doc.eol !== snapshot.eol
  );
}

function findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const docs = vscode.workspace.textDocuments ?? [];
  const key = uri.toString();
  return docs.find((d) => !d.isClosed && d.uri.toString() === key);
}

function buildProposedEditExpectation(
  doc: vscode.TextDocument,
  edits: readonly vscode.TextEdit[]
): ProposedEditExpectation {
  const preText = doc.getText();
  const effectiveEol = computeEffectiveEol(doc.eol, edits);
  const proposedSpecs: ProposedEditSpec[] = [];
  const normalizedOffsets: OffsetTextEdit[] = [];
  const rawOffsets: OffsetTextEdit[] = [];

  for (const te of edits) {
    if (te.newEol !== undefined && te.newText.length === 0 && te.range.isEmpty) {
      continue;
    }
    const startOffset = doc.offsetAt(te.range.start);
    const endOffset = doc.offsetAt(te.range.end);
    const normalizedNewText = normalizeTextForEol(te.newText, effectiveEol);
    proposedSpecs.push({
      startOffset,
      endOffset,
      rawNewText: te.newText,
      normalizedNewText,
    });
    normalizedOffsets.push({ startOffset, endOffset, newText: normalizedNewText });
    rawOffsets.push({ startOffset, endOffset, newText: te.newText });
  }

  const appliedNorm = applyOffsetEdits(preText, normalizedOffsets);
  const expectedNormalizedText =
    appliedNorm === null
      ? null
      : effectiveEol !== doc.eol
        ? normalizeTextForEol(appliedNorm, effectiveEol)
        : appliedNorm;
  const expectedRawText = applyOffsetEdits(preText, rawOffsets);

  return {
    effectiveEol,
    proposedSpecs,
    expectedNormalizedText,
    expectedRawText,
  };
}

function doesContentChangesMatchProposedSubset(
  preText: string,
  actualText: string,
  contentChanges: readonly vscode.TextDocumentContentChangeEvent[],
  proposed: readonly ProposedEditSpec[]
): boolean {
  if (contentChanges.length === 0 || contentChanges.length > proposed.length) {
    return false;
  }

  const used = new Array<boolean>(proposed.length).fill(false);
  const matchedNormalized: OffsetTextEdit[] = [];
  const matchedRaw: OffsetTextEdit[] = [];

  for (const change of contentChanges) {
    let foundIndex = -1;
    for (let i = 0; i < proposed.length; i++) {
      if (used[i]) {
        continue;
      }
      const spec = proposed[i];
      if (
        change.rangeOffset === spec.startOffset &&
        change.rangeLength === spec.endOffset - spec.startOffset &&
        (change.text === spec.normalizedNewText || change.text === spec.rawNewText)
      ) {
        foundIndex = i;
        break;
      }
    }
    if (foundIndex === -1) {
      return false;
    }

    used[foundIndex] = true;
    const matched = proposed[foundIndex];
    matchedNormalized.push({
      startOffset: matched.startOffset,
      endOffset: matched.endOffset,
      newText: matched.normalizedNewText,
    });
    matchedRaw.push({
      startOffset: matched.startOffset,
      endOffset: matched.endOffset,
      newText: matched.rawNewText,
    });
  }

  const expectedNorm = applyOffsetEdits(preText, matchedNormalized);
  if (expectedNorm !== null && actualText === expectedNorm) {
    return true;
  }
  const expectedRaw = applyOffsetEdits(preText, matchedRaw);
  return expectedRaw !== null && actualText === expectedRaw;
}

function createTargetChangeTracker(): TargetChangeTracker {
  return {
    textChangeEvents: 0,
    allEventsMatchedProposed: true,
    matchedAnyProposed: false,
    lastEventHadUndoOrRedo: false,
  };
}

function recordTargetChangeEvent(
  event: vscode.TextDocumentChangeEvent,
  preText: string,
  expectation: ProposedEditExpectation,
  tracker: TargetChangeTracker
): void {
  tracker.textChangeEvents++;
  if (event.reason !== undefined) {
    tracker.lastEventHadUndoOrRedo = true;
    tracker.allEventsMatchedProposed = false;
    return;
  }

  const actualText = event.document.getText();
  const matchesFull =
    tracker.textChangeEvents === 1 &&
    event.document.eol === expectation.effectiveEol &&
    ((expectation.expectedNormalizedText !== null &&
      actualText === expectation.expectedNormalizedText) ||
      (expectation.expectedRawText !== null && actualText === expectation.expectedRawText));
  const matchesSubset =
    tracker.textChangeEvents === 1 &&
    doesContentChangesMatchProposedSubset(
      preText,
      actualText,
      event.contentChanges,
      expectation.proposedSpecs
    );

  if (matchesFull || matchesSubset) {
    tracker.matchedAnyProposed = true;
  } else {
    tracker.allEventsMatchedProposed = false;
  }
}

function delayWithCancellation(ms: number, token: vscode.CancellationToken): Promise<void> {
  if (token.isCancellationRequested) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const subscription = token.onCancellationRequested(() => {
      clearTimeout(timer);
      subscription.dispose();
      resolve();
    });
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve();
    }, ms);
  });
}

function getInstalledExtensionsSignature(): string {
  try {
    const all = vscode.extensions?.all;
    if (!Array.isArray(all) || all.length === 0) {
      return '';
    }
    return all
      .map((ext) => ext.id)
      .sort()
      .join('\0');
  } catch {
    return '';
  }
}

function pruneDocEmptyRetryEntries(bucket: ExhaustedEmptyRetryDocBucket, now: number): void {
  for (const [kind, entry] of bucket.entries) {
    if (now >= entry.expiresAt) {
      bucket.entries.delete(kind);
    }
  }
}

function deleteDocFromEmptyRetryCache(
  doc: vscode.TextDocument,
  bucket?: ExhaustedEmptyRetryDocBucket
): void {
  const existing = bucket ?? exhaustedEmptyRetryCache.get(doc);
  if (existing) {
    exhaustedEmptyRetryDocRefs.delete(existing.ref);
    exhaustedEmptyRetryCache.delete(doc);
  }
}

function pruneEmptyRetryCacheDocs(now: number): void {
  for (const ref of exhaustedEmptyRetryDocRefs) {
    const trackedDoc = ref.deref();
    if (!trackedDoc || trackedDoc.isClosed) {
      exhaustedEmptyRetryDocRefs.delete(ref);
      if (trackedDoc) {
        exhaustedEmptyRetryCache.delete(trackedDoc);
      }
      continue;
    }
    const bucket = exhaustedEmptyRetryCache.get(trackedDoc);
    if (!bucket) {
      exhaustedEmptyRetryDocRefs.delete(ref);
      continue;
    }
    pruneDocEmptyRetryEntries(bucket, now);
    if (bucket.entries.size === 0) {
      exhaustedEmptyRetryDocRefs.delete(ref);
      exhaustedEmptyRetryCache.delete(trackedDoc);
    }
  }
}

function clearExhaustedEmptyRetryForKind(
  doc: vscode.TextDocument,
  targetKindValue: string
): void {
  const bucket = exhaustedEmptyRetryCache.get(doc);
  if (!bucket) {
    return;
  }
  bucket.entries.delete(targetKindValue);
  if (bucket.entries.size === 0) {
    deleteDocFromEmptyRetryCache(doc, bucket);
  }
}

function hasFreshExhaustedEmptyRetry(
  doc: vscode.TextDocument,
  targetKindValue: string,
  snapshot: DocumentSnapshot,
  languageId: string
): boolean {
  if (doc.isClosed) {
    deleteDocFromEmptyRetryCache(doc);
    return false;
  }
  const bucket = exhaustedEmptyRetryCache.get(doc);
  if (!bucket) {
    return false;
  }
  const entry = bucket.entries.get(targetKindValue);
  if (!entry) {
    return false;
  }
  const now = performance.now();
  if (now >= entry.expiresAt) {
    bucket.entries.delete(targetKindValue);
    if (bucket.entries.size === 0) {
      deleteDocFromEmptyRetryCache(doc, bucket);
    }
    return false;
  }
  if (
    doc.version !== snapshot.version ||
    doc.eol !== snapshot.eol ||
    doc.languageId !== languageId ||
    entry.version !== snapshot.version ||
    entry.eol !== snapshot.eol ||
    entry.languageId !== languageId ||
    entry.extensionsSignature !== getInstalledExtensionsSignature()
  ) {
    bucket.entries.delete(targetKindValue);
    if (bucket.entries.size === 0) {
      deleteDocFromEmptyRetryCache(doc, bucket);
    }
    return false;
  }
  // Keep doc recent in LRU order without extending the entry's fixed TTL.
  exhaustedEmptyRetryDocRefs.delete(bucket.ref);
  exhaustedEmptyRetryDocRefs.add(bucket.ref);
  return true;
}

function recordExhaustedEmptyRetry(
  doc: vscode.TextDocument,
  targetKindValue: string,
  snapshot: DocumentSnapshot,
  languageId: string
): void {
  if (doc.isClosed) {
    deleteDocFromEmptyRetryCache(doc);
    return;
  }

  const now = performance.now();
  pruneEmptyRetryCacheDocs(now);

  let bucket = exhaustedEmptyRetryCache.get(doc);
  if (!bucket) {
    while (exhaustedEmptyRetryDocRefs.size >= EMPTY_RETRY_CACHE_MAX_DOCS) {
      const oldestRef = exhaustedEmptyRetryDocRefs.values().next().value;
      if (!oldestRef) {
        break;
      }
      exhaustedEmptyRetryDocRefs.delete(oldestRef);
      const oldestDoc = oldestRef.deref();
      if (oldestDoc) {
        exhaustedEmptyRetryCache.delete(oldestDoc);
      }
    }
    bucket = {
      ref: new WeakRef(doc),
      entries: new Map(),
    };
    exhaustedEmptyRetryCache.set(doc, bucket);
  } else {
    pruneDocEmptyRetryEntries(bucket, now);
    exhaustedEmptyRetryDocRefs.delete(bucket.ref);
  }

  exhaustedEmptyRetryDocRefs.add(bucket.ref);

  if (bucket.entries.has(targetKindValue)) {
    bucket.entries.delete(targetKindValue);
  } else {
    while (bucket.entries.size >= EMPTY_RETRY_CACHE_MAX_KINDS_PER_DOC) {
      const oldestKind = bucket.entries.keys().next().value;
      if (oldestKind === undefined) {
        break;
      }
      bucket.entries.delete(oldestKind);
    }
  }

  bucket.entries.set(targetKindValue, {
    version: snapshot.version,
    languageId,
    eol: snapshot.eol,
    extensionsSignature: getInstalledExtensionsSignature(),
    expiresAt: now + EMPTY_RETRY_CACHE_TTL_MS,
  });
}

async function fetchCodeActions(
  doc: vscode.TextDocument,
  targetKind: vscode.CodeActionKind
): Promise<CodeActionResult[] | undefined> {
  const lastLine = Math.max(0, doc.lineCount - 1);
  const fullRange = new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).text.length);

  return vscode.commands.executeCommand<CodeActionResult[]>(
    'vscode.executeCodeActionProvider',
    doc.uri,
    fullRange,
    targetKind.value,
    ITEM_RESOLVE_COUNT
  );
}

type WorkspaceEditGuardResult =
  | { ok: true; singleDocEdits: vscode.TextEdit[]; totalEntryCount: number }
  | { ok: false; reason: string };

/**
 * Guards against multi-file, out-of-scope, or non-text WorkspaceEdit operations.
 *
 * Limitation: VS Code's WorkspaceEdit API does not expose file operations
 * (createFile/deleteFile/renameFile) or notebook edits separately from `size` and
 * `entries()`. Comparing `edit.size` against unique text-edit URIs catches
 * non-text operations on distinct URIs, and copying only verified `TextEdit`s into
 * a fresh WorkspaceEdit prevents hidden non-text operations on the same URI from
 * being applied.
 */
function inspectWorkspaceEditScope(
  doc: vscode.TextDocument,
  edit: vscode.WorkspaceEdit,
  allowedTargetUris?: ReadonlySet<string>
): WorkspaceEditGuardResult {
  const entries = edit.entries();
  const uniqueEntryUris = new Set(entries.map(([u]) => u.toString()));

  if (typeof edit.size === 'number' && edit.size > uniqueEntryUris.size) {
    return {
      ok: false,
      reason:
        'Action proposed non-text workspace edit operations that cannot be safely verified; skipped.',
    };
  }

  const docUriString = doc.uri.toString();
  const singleDocEdits: vscode.TextEdit[] = [];

  for (const [editUri, textEdits] of entries) {
    if (editUri.toString() === docUriString) {
      singleDocEdits.push(...textEdits);
    } else if (textEdits.length > 0) {
      const displayPath = formatDisplayPath(editUri);
      if (allowedTargetUris && !allowedTargetUris.has(editUri.toString())) {
        return {
          ok: false,
          reason: `Action proposed edits to out-of-scope file (${displayPath}); skipped.`,
        };
      }
      return {
        ok: false,
        reason: `Action proposed multi-file edits targeting another file (${displayPath}); skipped.`,
      };
    }
  }

  return { ok: true, singleDocEdits, totalEntryCount: entries.length };
}

function extractEffectiveSingleDocEdits(
  doc: vscode.TextDocument,
  textEdits: readonly vscode.TextEdit[]
): vscode.TextEdit[] {
  if (textEdits.length === 0) {
    return [];
  }

  const targetEol = computeEffectiveEol(doc.eol, textEdits);
  const eolChanges = targetEol !== doc.eol;
  const nonTrivial = textEdits.filter((te) => {
    if (te.newEol !== undefined && te.newEol !== doc.eol) {
      return true;
    }
    const normalizedNewText = normalizeTextForEol(te.newText, targetEol);
    return doc.getText(te.range) !== normalizedNewText;
  });

  if (nonTrivial.length === 0) {
    return [];
  }

  if (eolChanges) {
    return nonTrivial;
  }

  const docText = doc.getText();
  const offsetEdits: OffsetTextEdit[] = nonTrivial.map((te) => ({
    startOffset: doc.offsetAt(te.range.start),
    endOffset: doc.offsetAt(te.range.end),
    newText: normalizeTextForEol(te.newText, targetEol),
  }));
  if (!wouldOffsetEditsChangeText(docText, offsetEdits)) {
    return [];
  }

  return nonTrivial;
}

function prioritizeActions(actions: readonly CodeActionResult[]): CodeActionResult[] {
  return actions
    .map((action, index) => ({
      action,
      index,
      priority: !isCommandItem(action) && action.isPreferred === true ? 0 : 1,
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((entry) => entry.action);
}

/**
 * Requests (and optionally applies) import-organizing code actions for one document.
 */
export async function organizeImportsInDocument(
  target: vscode.TextDocument | vscode.Uri,
  options: {
    targetKind: vscode.CodeActionKind;
    isFirstForLanguage: boolean;
    saveAfterOrganize: boolean;
    dryRun: boolean;
    token: vscode.CancellationToken;
    allowedTargetUris?: ReadonlySet<string>;
  }
): Promise<OrganizeDocumentResult> {
  const timings: DocumentPhaseTimings = {
    openMs: 0,
    providerMs: 0,
    retryWaitMs: 0,
    retryCount: 0,
    applyMs: 0,
    saveMs: 0,
  };

  let doc: vscode.TextDocument;
  if (isTextDocument(target)) {
    doc = target;
  } else {
    const openStart = performance.now();
    doc = await vscode.workspace.openTextDocument(target);
    timings.openMs += performance.now() - openStart;
  }

  const entryWasDirty = doc.isDirty;

  const makeResult = (
    outcome: OrganizeDocumentOutcome,
    overrides?: Partial<OrganizeDocumentResult>
  ): OrganizeDocumentResult => ({
    modified: false,
    languageId: doc.languageId,
    wasDirty: entryWasDirty,
    leftUnsaved: false,
    previewEdits: [],
    outcome,
    timings,
    ...overrides,
  });

  const staleErrorResult = (): OrganizeDocumentResult =>
    makeResult('error', {
      wasDirty: entryWasDirty || doc.isDirty,
      errorMessage: options.dryRun
        ? 'Document changed while requesting code actions; skipped to avoid stale preview ranges.'
        : 'Document changed while requesting code actions; skipped to avoid applying stale edits.',
    });

  if (options.token.isCancellationRequested) {
    return makeResult('unchanged', { cancelled: true });
  }

  if (doc.isClosed) {
    deleteDocFromEmptyRetryCache(doc);
    return makeResult('error', {
      errorMessage: 'Document was closed before organizing imports.',
    });
  }

  const timedFetchActions = async (): Promise<CodeActionResult[] | undefined> => {
    const start = performance.now();
    try {
      return await fetchCodeActions(doc, options.targetKind);
    } finally {
      timings.providerMs += performance.now() - start;
    }
  };

  const entrySnapshot = captureSnapshot(doc);
  const entryLanguageId = doc.languageId;
  let requestSnapshot = entrySnapshot;
  let actions = await timedFetchActions();

  if (options.token.isCancellationRequested) {
    return makeResult('unchanged', { cancelled: true });
  }

  if (actions && actions.length > 0) {
    clearExhaustedEmptyRetryForKind(doc, options.targetKind.value);
  }

  // Give a newly activated language server (e.g. tsserver, Pylance) time to
  // register its code action provider on the first file of that language.
  // Skip redundant retries only if this live document+kind+version already
  // exhausted an uncancelled cold-start retry loop recently.
  if (
    options.isFirstForLanguage &&
    (!actions || actions.length === 0) &&
    !hasFreshExhaustedEmptyRetry(doc, options.targetKind.value, entrySnapshot, entryLanguageId)
  ) {
    let completedRetryAttempts = 0;
    for (const delayMs of COLD_START_DELAYS_MS) {
      if (options.token.isCancellationRequested) {
        break;
      }
      timings.retryCount++;
      const waitStart = performance.now();
      await delayWithCancellation(delayMs, options.token);
      timings.retryWaitMs += performance.now() - waitStart;
      if (options.token.isCancellationRequested) {
        break;
      }
      if (doc.isClosed) {
        deleteDocFromEmptyRetryCache(doc);
        return makeResult('error', {
          errorMessage: 'Document was closed while waiting for language provider.',
        });
      }
      requestSnapshot = captureSnapshot(doc);
      actions = await timedFetchActions();
      if (options.token.isCancellationRequested) {
        break;
      }
      completedRetryAttempts++;
      if (actions && actions.length > 0) {
        clearExhaustedEmptyRetryForKind(doc, options.targetKind.value);
        break;
      }
    }

    if (
      completedRetryAttempts === COLD_START_DELAYS_MS.length &&
      !options.token.isCancellationRequested &&
      !doc.isClosed &&
      (!actions || actions.length === 0) &&
      !isDocumentStale(doc, entrySnapshot) &&
      !isDocumentStale(doc, requestSnapshot) &&
      doc.languageId === entryLanguageId
    ) {
      recordExhaustedEmptyRetry(doc, options.targetKind.value, requestSnapshot, entryLanguageId);
    }
  }

  if (options.token.isCancellationRequested) {
    return makeResult('unchanged', { cancelled: true });
  }

  const orderedActions = prioritizeActions(actions ?? []);
  const changedDuringRequest = isDocumentStale(doc, requestSnapshot);
  const hadInterveningEditBeforeAction =
    doc.version !== entrySnapshot.version ||
    doc.getText() !== entrySnapshot.text ||
    doc.eol !== entrySnapshot.eol ||
    (!entryWasDirty && doc.isDirty);

  if (orderedActions.length > 0 && changedDuringRequest) {
    const hasRelevantAction = orderedActions.some(
      (item) => isCommandItem(item) || isMatchingActionKind(item, options.targetKind)
    );
    if (hasRelevantAction) {
      return staleErrorResult();
    }
  }

  if (options.dryRun) {
    const previewEdits: PreviewTextEditEntry[] = [];
    let matchedActionCount = 0;
    let sawCommandOnlyAction = false;
    let blockedError: string | undefined;

    for (const item of orderedActions) {
      if (options.token.isCancellationRequested) {
        return makeResult('unchanged', {
          wasDirty: entryWasDirty || doc.isDirty,
          cancelled: true,
        });
      }
      if (isCommandItem(item)) {
        matchedActionCount++;
        sawCommandOnlyAction = true;
        continue;
      }
      if (!isMatchingActionKind(item, options.targetKind)) {
        continue;
      }

      matchedActionCount++;

      if (item.edit) {
        const guard = inspectWorkspaceEditScope(doc, item.edit, options.allowedTargetUris);
        if (!guard.ok) {
          blockedError ??= guard.reason;
          continue;
        }

        const effective = extractEffectiveSingleDocEdits(doc, guard.singleDocEdits);
        if (effective.length > 0) {
          if (isDocumentStale(doc, requestSnapshot)) {
            return staleErrorResult();
          }

          previewEdits.push({
            uri: doc.uri,
            edits: effective,
            baseline: {
              uri: doc.uri,
              version: doc.version,
              text: doc.getText(),
              eol: doc.eol,
              wasDirty: entryWasDirty || doc.isDirty,
              document: doc,
            },
          });
          break;
        }

        if (guard.totalEntryCount === 0 && item.command) {
          sawCommandOnlyAction = true;
        }
        continue;
      }

      if (item.command) {
        sawCommandOnlyAction = true;
      }
    }

    const dryRunWasDirty = entryWasDirty || doc.isDirty;

    if (previewEdits.length > 0) {
      return makeResult('would-modify', {
        modified: true,
        wasDirty: dryRunWasDirty,
        previewEdits,
      });
    }

    if (blockedError) {
      return makeResult('error', {
        wasDirty: dryRunWasDirty,
        errorMessage: blockedError,
      });
    }

    if (sawCommandOnlyAction) {
      return makeResult('command-only', {
        wasDirty: dryRunWasDirty,
        errorMessage: 'action cannot be previewed',
      });
    }

    return makeResult(matchedActionCount === 0 ? 'no-action' : 'unchanged', {
      wasDirty: dryRunWasDirty,
    });
  }

  // Direct execution mode (dryRun === false)
  let matchedActionCount = 0;
  let executedAction = false;
  let blockedError: string | undefined;
  let preActionSnapshot = captureSnapshot(doc);
  let preActionDirty = doc.isDirty;
  let hadInterveningEditDuringApply = false;

  const timedExecuteCommand = async (command: string, args?: unknown[]): Promise<void> => {
    const start = performance.now();
    try {
      await vscode.commands.executeCommand(command, ...(args ?? []));
    } finally {
      timings.applyMs += performance.now() - start;
    }
  };

  for (const item of orderedActions) {
    if (options.token.isCancellationRequested) {
      break;
    }

    if (isCommandItem(item)) {
      matchedActionCount++;
      if (isDocumentStale(doc, requestSnapshot)) {
        return staleErrorResult();
      }
      preActionSnapshot = captureSnapshot(doc);
      preActionDirty = doc.isDirty;
      await timedExecuteCommand(item.command, item.arguments);
      executedAction = true;
      break;
    }

    if (!isMatchingActionKind(item, options.targetKind)) {
      continue;
    }

    matchedActionCount++;

    if (item.edit) {
      const guard = inspectWorkspaceEditScope(doc, item.edit, options.allowedTargetUris);
      if (!guard.ok) {
        blockedError ??= guard.reason;
        continue;
      }

      const effective = extractEffectiveSingleDocEdits(doc, guard.singleDocEdits);
      if (effective.length === 0) {
        if (guard.totalEntryCount === 0 && item.command) {
          if (isDocumentStale(doc, requestSnapshot)) {
            return staleErrorResult();
          }
          preActionSnapshot = captureSnapshot(doc);
          preActionDirty = doc.isDirty;
          await timedExecuteCommand(item.command.command, item.command.arguments);
          executedAction = true;
          break;
        }
        continue;
      }

      if (isDocumentStale(doc, requestSnapshot)) {
        return staleErrorResult();
      }

      preActionSnapshot = captureSnapshot(doc);
      preActionDirty = doc.isDirty;
      const expectation = buildProposedEditExpectation(doc, effective);

      const filteredEdit = new vscode.WorkspaceEdit();
      filteredEdit.set(doc.uri, effective);

      const docKey = doc.uri.toString();
      const tracker = createTargetChangeTracker();
      const hasChangeListener = typeof vscode.workspace.onDidChangeTextDocument === 'function';
      const changeListener = hasChangeListener
        ? vscode.workspace.onDidChangeTextDocument((event) => {
            if (
              event.document.uri.toString() !== docKey ||
              event.contentChanges.length === 0
            ) {
              return;
            }
            recordTargetChangeEvent(event, preActionSnapshot.text, expectation, tracker);
          })
        : undefined;

      let applied: boolean;
      const applyStart = performance.now();
      try {
        applied = await vscode.workspace.applyEdit(filteredEdit);
      } finally {
        timings.applyMs += performance.now() - applyStart;
        changeListener?.dispose();
      }

      if (!applied) {
        return makeResult('error', {
          errorMessage: 'Failed to apply workspace edit.',
        });
      }

      executedAction = true;

      if (!item.command && !doc.isClosed) {
        const currentText = doc.getText();
        const currentEol = doc.eol;
        const textOrEolChanged =
          currentText !== preActionSnapshot.text || currentEol !== preActionSnapshot.eol;
        const matchesFull =
          currentEol === expectation.effectiveEol &&
          ((expectation.expectedNormalizedText !== null &&
            currentText === expectation.expectedNormalizedText) ||
            (expectation.expectedRawText !== null &&
              currentText === expectation.expectedRawText));

        if (hasChangeListener) {
          const cleanApply =
            tracker.textChangeEvents <= 1 &&
            !tracker.lastEventHadUndoOrRedo &&
            (matchesFull ||
              (tracker.textChangeEvents === 1 && tracker.allEventsMatchedProposed));
          if ((textOrEolChanged || tracker.textChangeEvents > 0) && !cleanApply) {
            hadInterveningEditDuringApply = true;
          }
        } else if (
          textOrEolChanged &&
          expectation.expectedNormalizedText !== null &&
          !matchesFull
        ) {
          hadInterveningEditDuringApply = true;
        }
      }

      if (item.command && !options.token.isCancellationRequested) {
        await timedExecuteCommand(item.command.command, item.command.arguments);
      }
      break;
    }

    if (item.command) {
      if (isDocumentStale(doc, requestSnapshot)) {
        return staleErrorResult();
      }
      preActionSnapshot = captureSnapshot(doc);
      preActionDirty = doc.isDirty;
      await timedExecuteCommand(item.command.command, item.command.arguments);
      executedAction = true;
      break;
    }
  }

  if (options.token.isCancellationRequested && !executedAction) {
    return makeResult('unchanged', { cancelled: true });
  }

  if (!executedAction) {
    if (blockedError) {
      return makeResult('error', { errorMessage: blockedError });
    }
    return makeResult(matchedActionCount === 0 ? 'no-action' : 'unchanged');
  }

  const changedByAction =
    !doc.isClosed &&
    (doc.version !== preActionSnapshot.version ||
      doc.getText() !== preActionSnapshot.text ||
      doc.eol !== preActionSnapshot.eol);

  const safeToAutoSave =
    options.saveAfterOrganize &&
    !entryWasDirty &&
    !hadInterveningEditBeforeAction &&
    !preActionDirty &&
    !hadInterveningEditDuringApply &&
    !doc.isClosed &&
    changedByAction &&
    doc.isDirty;

  let saveFailed = false;
  let saveErrorMessage: string | undefined;

  // Save before checking whether text changed so formatOnSave / codeActionsOnSave
  // that revert purely stylistic edits do not inflate the modified file count.
  if (safeToAutoSave) {
    const saveStart = performance.now();
    try {
      const saved = await doc.save();
      if (!saved) {
        saveFailed = true;
      }
    } catch (err) {
      saveFailed = true;
      saveErrorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      timings.saveMs += performance.now() - saveStart;
    }
  }

  const modified =
    !doc.isClosed &&
    (doc.getText() !== preActionSnapshot.text || doc.eol !== preActionSnapshot.eol);
  const leftUnsaved = modified && doc.isDirty && !saveFailed;

  if (saveFailed) {
    const reason = saveErrorMessage
      ? modified
        ? `Modified, but failed to save: ${saveErrorMessage}`
        : `Failed to save: ${saveErrorMessage}`
      : modified
        ? 'Modified, but failed to save file.'
        : 'Failed to save file.';
    return makeResult('save-failed', {
      modified,
      saveFailed: true,
      errorMessage: reason,
    });
  }

  return makeResult(modified ? 'modified' : 'unchanged', {
    modified,
    leftUnsaved,
  });
}

interface RootFilterConfig {
  includeGlob: string;
  customExcludes: string[];
  ignoredFolders: string[];
  useWorkspaceExcludes: boolean;
  useGitIgnore: boolean;
  filesExclude: Record<string, unknown> | undefined;
  searchExclude: Record<string, unknown> | undefined;
  filter: CandidateFilter;
}

function readRootFilterConfig(scopeUri?: vscode.Uri): RootFilterConfig {
  const config = vscode.workspace.getConfiguration('organizeImportsAll', scopeUri);
  const configuredInclude = config.get<string>('include')?.trim();
  const includeGlob = configuredInclude || DEFAULT_INCLUDE_GLOB;
  const customExcludes = config.get<string[]>('exclude') ?? [...DEFAULT_EXCLUDE_PATTERNS];
  const ignoredFolders = config.get<string[]>('ignoredFolders') ?? [];
  const useWorkspaceExcludes = config.get<boolean>('useWorkspaceExcludes') ?? true;
  const useGitIgnore = config.get<boolean>('useGitIgnore') ?? true;

  const filesExclude = vscode.workspace
    .getConfiguration('files', scopeUri)
    .get<Record<string, unknown>>('exclude');
  const searchExclude = vscode.workspace
    .getConfiguration('search', scopeUri)
    .get<Record<string, unknown>>('exclude');

  const filter = createCandidateFilter({
    includeGlob,
    customExcludes,
    ignoredFolders,
    filesExclude,
    searchExclude,
    useWorkspaceExcludes,
  });

  return {
    includeGlob,
    customExcludes,
    ignoredFolders,
    useWorkspaceExcludes,
    useGitIgnore,
    filesExclude,
    searchExclude,
    filter,
  };
}

async function findFilesWithRootConfig(
  searchBase: vscode.WorkspaceFolder | vscode.Uri,
  rootBaseUri: vscode.Uri,
  rootConfig: RootFilterConfig,
  token: vscode.CancellationToken
): Promise<vscode.Uri[]> {
  const includePattern = new vscode.RelativePattern(searchBase, rootConfig.includeGlob);

  if (rootConfig.useWorkspaceExcludes) {
    return vscode.workspace.findFiles(
      includePattern,
      rootConfig.filter.effectiveExcludeGlob,
      undefined,
      token
    );
  }

  // Passing `null` disables VS Code's implicit `files.exclude`. Re-apply custom
  // exclusions (`organizeImportsAll.exclude` + `ignoredFolders`) afterward so
  // disabling workspace excludes never drops custom exclusions.
  const allIncluded = await vscode.workspace.findFiles(includePattern, null, undefined, token);
  if (token.isCancellationRequested || allIncluded.length === 0) {
    return [];
  }
  if (!rootConfig.filter.customExcludeGlob) {
    return allIncluded;
  }

  if (rootConfig.filter.canMatchCustomExcludesNatively) {
    return allIncluded.filter((uri) => {
      const rel = toRelativePosixForUri(rootBaseUri, uri);
      if (!rel) {
        return true;
      }
      return !rootConfig.filter.matchesCustomExclude(rel);
    });
  }

  // Native fallback when custom excludes use syntax whose parity cannot be guaranteed.
  const excludedUris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(rootBaseUri, rootConfig.filter.customExcludeGlob),
    null,
    undefined,
    token
  );
  if (token.isCancellationRequested) {
    return [];
  }
  const excludedKeys = new Set(excludedUris.map((u) => getUriDedupKey(u)));
  return allIncluded.filter((u) => !excludedKeys.has(getUriDedupKey(u)));
}

interface GitIgnoreFilterOutcome {
  files: vscode.Uri[];
  gitIgnoredCount: number;
  warnings: string[];
  aborted: boolean;
  gitMs: number;
}

async function applyGitIgnoreFilter(
  uris: readonly vscode.Uri[],
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  getRootConfig: (uri?: vscode.Uri) => RootFilterConfig,
  fallbackRoot: string | undefined,
  signal: AbortSignal
): Promise<GitIgnoreFilterOutcome> {
  if (signal.aborted) {
    return { files: [], gitIgnoredCount: 0, warnings: [], aborted: true, gitMs: 0 };
  }
  if (uris.length === 0) {
    return { files: [], gitIgnoredCount: 0, warnings: [], aborted: false, gitMs: 0 };
  }

  const groups = new Map<string, vscode.Uri[]>();
  const bypassKeys = new Set<string>();

  for (const uri of uris) {
    const wf = findOwningWorkspaceFolder(uri, workspaceFolders);
    const rootConfig = getRootConfig(wf?.uri);
    if (!rootConfig.useGitIgnore || uri.scheme !== 'file') {
      bypassKeys.add(getUriDedupKey(uri));
      continue;
    }

    const root =
      (wf?.uri.scheme === 'file' ? wf.uri.fsPath : undefined) ??
      fallbackRoot ??
      path.dirname(uri.fsPath);
    let bucket = groups.get(root);
    if (!bucket) {
      bucket = [];
      groups.set(root, bucket);
    }
    bucket.push(uri);
  }

  const keptKeys = new Set<string>(bypassKeys);
  const warnings: string[] = [];
  let gitIgnoredCount = 0;
  let gitMs = 0;

  for (const [root, groupUris] of groups.entries()) {
    if (signal.aborted) {
      return { files: [], gitIgnoredCount: 0, warnings, aborted: true, gitMs };
    }
    if (!root) {
      for (const uri of groupUris) {
        keptKeys.add(getUriDedupKey(uri));
      }
      continue;
    }

    const start = performance.now();
    const filtered = await filterGitIgnoredFiles(
      root,
      groupUris.map((u) => u.fsPath),
      { signal }
    );
    gitMs += performance.now() - start;

    if (filtered.aborted || signal.aborted) {
      return { files: [], gitIgnoredCount: 0, warnings, aborted: true, gitMs };
    }

    if (filtered.failures && filtered.failures.length > 0) {
      for (const failure of filtered.failures) {
        warnings.push(
          `.gitignore filtering failed (${formatGitFailure(failure)}); some ignored files may not have been skipped.`
        );
      }
    }

    gitIgnoredCount += filtered.ignoredCount;
    for (const keptPath of filtered.kept) {
      keptKeys.add(getCanonicalPathKey(keptPath));
    }
  }

  return {
    files: uris.filter((uri) => keptKeys.has(getUriDedupKey(uri))),
    gitIgnoredCount,
    warnings,
    aborted: false,
    gitMs,
  };
}

async function isAccessibleRegularFile(uri: vscode.Uri): Promise<boolean> {
  if (typeof vscode.workspace.fs?.stat === 'function') {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return (stat.type & vscode.FileType.File) !== 0;
    } catch {
      return false;
    }
  }
  if (uri.scheme === 'file') {
    try {
      return (await fs.promises.stat(uri.fsPath)).isFile();
    } catch {
      return false;
    }
  }
  return true;
}

async function filterCandidateUris(
  candidateUris: readonly vscode.Uri[],
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  getRootConfig: (uri?: vscode.Uri) => RootFilterConfig,
  token: vscode.CancellationToken
): Promise<vscode.Uri[]> {
  const byFolder = new Map<
    string,
    { folder: vscode.WorkspaceFolder; uris: vscode.Uri[] }
  >();
  const outsideWorkspace: vscode.Uri[] = [];

  for (const uri of candidateUris) {
    const wf = findOwningWorkspaceFolder(uri, workspaceFolders);
    if (!wf) {
      outsideWorkspace.push(uri);
      continue;
    }
    const key = wf.uri.toString();
    let bucket = byFolder.get(key);
    if (!bucket) {
      bucket = { folder: wf, uris: [] };
      byFolder.set(key, bucket);
    }
    bucket.uris.push(uri);
  }

  const matchedByKey = new Map<string, vscode.Uri>();

  for (const { folder, uris } of byFolder.values()) {
    if (token.isCancellationRequested) {
      return [];
    }
    const rootConfig = getRootConfig(folder.uri);

    if (rootConfig.filter.canMatchAllNatively) {
      for (const uri of uris) {
        const relPosix = toRelativePosixForUri(folder.uri, uri);
        if (relPosix && rootConfig.filter.matchesCandidate(relPosix)) {
          matchedByKey.set(getUriDedupKey(uri), uri);
        }
      }
    } else {
      // Stable native fallback when custom globs or conditional files.exclude
      // rules prevent guaranteed in-memory parity.
      const candidateKeys = new Set(uris.map((u) => getUriDedupKey(u)));
      const nativeFound = await findFilesWithRootConfig(folder, folder.uri, rootConfig, token);
      if (token.isCancellationRequested) {
        return [];
      }
      for (const uri of nativeFound) {
        const key = getUriDedupKey(uri);
        if (candidateKeys.has(key)) {
          matchedByKey.set(key, uri);
        }
      }
    }
  }

  if (outsideWorkspace.length > 0 && !token.isCancellationRequested) {
    const rootConfig = getRootConfig(undefined);
    if (rootConfig.filter.canMatchAllNatively) {
      for (const uri of outsideWorkspace) {
        const matchPath =
          uri.scheme === 'file'
            ? (toPosixRelativePath(path.parse(uri.fsPath).root, uri.fsPath) ??
              path.basename(uri.fsPath))
            : uri.path.replace(/^\/+/, '');
        if (matchPath && rootConfig.filter.matchesCandidate(matchPath)) {
          matchedByKey.set(getUriDedupKey(uri), uri);
        }
      }
    } else {
      const byParentDir = new Map<string, vscode.Uri[]>();
      for (const uri of outsideWorkspace) {
        if (uri.scheme !== 'file') {
          continue;
        }
        const dir = path.dirname(uri.fsPath);
        let bucket = byParentDir.get(dir);
        if (!bucket) {
          bucket = [];
          byParentDir.set(dir, bucket);
        }
        bucket.push(uri);
      }
      for (const [dir, dirUris] of byParentDir.entries()) {
        if (token.isCancellationRequested) {
          return [];
        }
        const dirUri = vscode.Uri.file(dir);
        const candidateKeys = new Set(dirUris.map((u) => getUriDedupKey(u)));
        const nativeFound = await findFilesWithRootConfig(dirUri, dirUri, rootConfig, token);
        if (token.isCancellationRequested) {
          return [];
        }
        for (const uri of nativeFound) {
          const key = getUriDedupKey(uri);
          if (candidateKeys.has(key)) {
            matchedByKey.set(key, uri);
          }
        }
      }
    }
  }

  return Array.from(matchedByKey.values());
}

type DiscoveryStatus = 'ok' | 'incomplete' | 'fatal' | 'cancelled';

interface DiscoveredFiles {
  status: DiscoveryStatus;
  files: vscode.Uri[];
  gitIgnoredCount: number;
  warnings: string[];
  fatalMessage?: string;
  earlyMessage?: { kind: 'info' | 'warning'; text: string };
  timings: {
    discoveryMs: number;
    gitMs: number;
  };
}

async function discoverTargetFiles(
  scope: OrganizeScope,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  token: vscode.CancellationToken
): Promise<DiscoveredFiles> {
  const discoveryStart = performance.now();
  let gitMs = 0;

  const rootConfigCache = new Map<string, RootFilterConfig>();
  const getRootConfig = (uri?: vscode.Uri): RootFilterConfig => {
    const key = uri ? uri.toString() : '';
    let cached = rootConfigCache.get(key);
    if (!cached) {
      cached = readRootFilterConfig(uri);
      rootConfigCache.set(key, cached);
    }
    return cached;
  };

  const buildResult = (
    status: DiscoveryStatus,
    partial?: Partial<Omit<DiscoveredFiles, 'status' | 'timings'>>
  ): DiscoveredFiles => ({
    status,
    files: partial?.files ?? [],
    gitIgnoredCount: partial?.gitIgnoredCount ?? 0,
    warnings: partial?.warnings ?? [],
    fatalMessage: partial?.fatalMessage,
    earlyMessage: partial?.earlyMessage,
    timings: {
      discoveryMs: performance.now() - discoveryStart,
      gitMs,
    },
  });

  const abortHandle = createAbortControllerForToken(token);
  const { signal } = abortHandle;

  try {
    if (token.isCancellationRequested) {
      return buildResult('cancelled');
    }

    if (scope.kind === 'workspace') {
      const byKey = new Map<string, vscode.Uri>();
      for (const wf of workspaceFolders) {
        if (token.isCancellationRequested) {
          return buildResult('cancelled');
        }
        const rootConfig = getRootConfig(wf.uri);
        const found = await findFilesWithRootConfig(wf, wf.uri, rootConfig, token);
        if (token.isCancellationRequested) {
          return buildResult('cancelled');
        }
        for (const uri of found) {
          byKey.set(getUriDedupKey(uri), uri);
        }
      }

      const candidates = Array.from(byKey.values());
      const gitIgnoreOutcome = await applyGitIgnoreFilter(
        candidates,
        workspaceFolders,
        getRootConfig,
        workspaceFolders[0]?.uri.scheme === 'file' ? workspaceFolders[0].uri.fsPath : undefined,
        signal
      );
      gitMs += gitIgnoreOutcome.gitMs;

      if (gitIgnoreOutcome.aborted || token.isCancellationRequested) {
        return buildResult('cancelled');
      }

      return buildResult(gitIgnoreOutcome.warnings.length > 0 ? 'incomplete' : 'ok', {
        files: gitIgnoreOutcome.files,
        gitIgnoredCount: gitIgnoreOutcome.gitIgnoredCount,
        warnings: gitIgnoreOutcome.warnings,
      });
    }

    if (scope.kind === 'folders' || scope.kind === 'files') {
      const selected = new Map<string, vscode.Uri>();
      if (scope.kind === 'files') {
        const accessible: vscode.Uri[] = [];
        for (const uri of new Map(scope.files.map((file) => [getUriDedupKey(file), file])).values()) {
          if (token.isCancellationRequested) {
            return buildResult('cancelled');
          }
          if (await isAccessibleRegularFile(uri)) {
            accessible.push(uri);
          }
        }

        const matched = await filterCandidateUris(accessible, workspaceFolders, getRootConfig, token);
        for (const uri of matched) {
          selected.set(getUriDedupKey(uri), uri);
        }
      }

      for (const folderUri of scope.folders ?? []) {
        if (token.isCancellationRequested) {
          return buildResult('cancelled');
        }
        const rootUri = findOwningWorkspaceFolder(folderUri, workspaceFolders)?.uri ?? folderUri;
        const found = await findFilesWithRootConfig(folderUri, rootUri, getRootConfig(rootUri), token);
        for (const uri of found) {
          selected.set(getUriDedupKey(uri), uri);
        }
      }
      if (token.isCancellationRequested) {
        return buildResult('cancelled');
      }

      const gitIgnoreOutcome = await applyGitIgnoreFilter(
        Array.from(selected.values()),
        workspaceFolders,
        getRootConfig,
        undefined,
        signal
      );
      gitMs += gitIgnoreOutcome.gitMs;
      if (gitIgnoreOutcome.aborted || token.isCancellationRequested) {
        return buildResult('cancelled');
      }

      return buildResult(gitIgnoreOutcome.warnings.length > 0 ? 'incomplete' : 'ok', {
        files: gitIgnoreOutcome.files,
        gitIgnoredCount: gitIgnoreOutcome.gitIgnoredCount,
        warnings: gitIgnoreOutcome.warnings,
      });
    }

    // Git scopes: 'gitChanged' and 'gitBranch'
    const trimmedBaseRef = scope.kind === 'gitBranch' ? scope.baseRef.trim() : '';
    if (
      scope.kind === 'gitBranch' &&
      (!trimmedBaseRef || trimmedBaseRef.startsWith('-') || /[\0\r\n\t ]/.test(trimmedBaseRef))
    ) {
      const msg = trimmedBaseRef
        ? `Invalid Git base ref: '${trimmedBaseRef}'.`
        : 'Base ref must be a non-empty Git reference.';
      return buildResult('fatal', {
        warnings: [msg],
        fatalMessage: msg,
      });
    }

    const localRoots = workspaceFolders
      .filter((wf) => wf.uri.scheme === 'file')
      .map((wf) => wf.uri.fsPath);
    if (localRoots.length === 0) {
      return buildResult('ok', {
        earlyMessage: {
          kind: 'warning',
          text: 'Git scopes require a local filesystem workspace folder.',
        },
      });
    }

    const repoDiscoverStart = performance.now();
    const repoDiscovery = await discoverGitRepositories(localRoots, {
      signal,
      knownRepoRoots: getKnownGitExtensionRepoRoots(),
    });
    gitMs += performance.now() - repoDiscoverStart;

    if (repoDiscovery.aborted || token.isCancellationRequested) {
      return buildResult('cancelled');
    }

    const warnings: string[] = [];
    for (const err of repoDiscovery.errors) {
      warnings.push(formatGitFailure(err));
    }
    if (repoDiscovery.truncated) {
      warnings.push(
        'Git repository discovery reached its bounded directory limit; deeply nested repositories may not have been inspected.'
      );
    }

    if (repoDiscovery.repositories.length === 0) {
      if (repoDiscovery.errors.length > 0) {
        return buildResult('fatal', {
          warnings,
          fatalMessage: `Git repository discovery failed: ${formatGitFailure(repoDiscovery.errors[0])}`,
        });
      }
      if (repoDiscovery.truncated) {
        return buildResult('incomplete', {
          warnings,
          earlyMessage: {
            kind: 'warning',
            text: 'No Git repositories were found within the bounded discovery limit.',
          },
        });
      }
      return buildResult('ok', {
        earlyMessage: {
          kind: 'warning',
          text: 'Current workspace is not a Git repository.',
        },
      });
    }

    const rawChangedPaths = new Map<string, string>();
    const repoErrors: GitFailure[] = [];
    let repoSuccessCount = 0;

    for (const repo of repoDiscovery.repositories) {
      if (token.isCancellationRequested || signal.aborted) {
        return buildResult('cancelled');
      }

      const queryStart = performance.now();
      const res =
        scope.kind === 'gitChanged'
          ? await getGitChangedFiles(repo.cwd, { signal })
          : await getGitBranchCommittedFiles(repo.cwd, trimmedBaseRef, { signal });
      gitMs += performance.now() - queryStart;

      if (res.aborted || token.isCancellationRequested) {
        return buildResult('cancelled');
      }

      if (res.error) {
        repoErrors.push(res.error);
        warnings.push(formatGitFailure(res.error));
        continue;
      }

      if (res.isRepo) {
        repoSuccessCount++;
        for (const absPath of res.files) {
          rawChangedPaths.set(getCanonicalPathKey(absPath), absPath);
        }
      }
    }

    if (repoSuccessCount === 0) {
      if (repoErrors.length > 0) {
        const prefix =
          scope.kind === 'gitChanged'
            ? 'Failed to query Git changed files'
            : `Failed to query Git branch commits against '${trimmedBaseRef}'`;
        return buildResult('fatal', {
          warnings,
          fatalMessage: `${prefix}: ${formatGitFailure(repoErrors[0])}`,
        });
      }
      return buildResult(warnings.length > 0 ? 'incomplete' : 'ok', {
        warnings,
        earlyMessage: {
          kind: 'warning',
          text: 'Current workspace is not a Git repository.',
        },
      });
    }

    if (rawChangedPaths.size === 0) {
      const status: DiscoveryStatus = warnings.length > 0 ? 'incomplete' : 'ok';
      return buildResult(status, {
        warnings,
        earlyMessage: {
          kind: status === 'incomplete' ? 'warning' : 'info',
          text:
            scope.kind === 'gitChanged'
              ? 'No Git changed or untracked files found.'
              : `No committed files changed between merge base of '${trimmedBaseRef}' and HEAD.`,
        },
      });
    }

    // Resolve Git paths into workspace-scoped URIs (skipping paths outside open folders).
    const workspaceCandidatesByKey = new Map<string, vscode.Uri>();
    for (const absPath of rawChangedPaths.values()) {
      const resolved = resolveGitPathToWorkspaceUri(absPath, workspaceFolders);
      if (resolved) {
        workspaceCandidatesByKey.set(getUriDedupKey(resolved.uri), resolved.uri);
      }
    }

    const matched = await filterCandidateUris(
      Array.from(workspaceCandidatesByKey.values()),
      workspaceFolders,
      getRootConfig,
      token
    );
    if (token.isCancellationRequested) {
      return buildResult('cancelled');
    }

    // For gitChanged, `getGitChangedFiles` already excludes ignored untracked files
    // while preserving staged/modified force-tracked files. For gitBranch, apply
    // `.gitignore` filtering so untracked ignored files are skipped while tracked
    // (including force-tracked) files are preserved by `git check-ignore`.
    let finalFiles = matched;
    let gitIgnoredCount = 0;
    if (scope.kind === 'gitBranch' && matched.length > 0) {
      const gitIgnoreOutcome = await applyGitIgnoreFilter(
        matched,
        workspaceFolders,
        getRootConfig,
        localRoots[0],
        signal
      );
      gitMs += gitIgnoreOutcome.gitMs;
      if (gitIgnoreOutcome.aborted || token.isCancellationRequested) {
        return buildResult('cancelled');
      }
      warnings.push(...gitIgnoreOutcome.warnings);
      gitIgnoredCount = gitIgnoreOutcome.gitIgnoredCount;
      finalFiles = gitIgnoreOutcome.files;
    }

    const status: DiscoveryStatus = warnings.length > 0 ? 'incomplete' : 'ok';
    if (finalFiles.length === 0) {
      return buildResult(status, {
        gitIgnoredCount,
        warnings,
        earlyMessage: {
          kind: status === 'incomplete' ? 'warning' : 'info',
          text:
            scope.kind === 'gitChanged'
              ? 'No matching code files among Git changed files.'
              : `No matching code files among commits between merge base of '${trimmedBaseRef}' and HEAD.`,
        },
      });
    }

    return buildResult(status, {
      files: finalFiles,
      gitIgnoredCount,
      warnings,
    });
  } finally {
    abortHandle.dispose();
  }
}

function getHeaderTitle(scope: OrganizeScope, dryRun: boolean): string {
  const suffix = dryRun ? ' (dry-run)' : '';
  switch (scope.kind) {
    case 'folders':
      return `Organize imports in folder${suffix}`;
    case 'files':
      return `Organize imports on selected files${suffix}`;
    case 'gitChanged':
      return `Organize imports on Git changed files${suffix}`;
    case 'gitBranch':
      return `Organize imports on Git branch (${scope.baseRef.trim()})${suffix}`;
    case 'workspace':
      return `Organize imports on all files${suffix}`;
  }
}

export interface SkippedPreviewTarget {
  uri: vscode.Uri;
  relativePath: string;
  reason: string;
}

export interface ApplyPreviewResult {
  applied: boolean;
  proposedCount: number;
  verifiedCount: number;
  appliedCount: number;
  countReliable: boolean;
  savedCount: number;
  skippedStale: SkippedPreviewTarget[];
  skippedConflicting: SkippedPreviewTarget[];
  saveFailedPaths: string[];
  leftUnsavedPaths: string[];
  interveningEditPaths: string[];
  applyMs?: number;
  saveMs?: number;
}

interface VerifiedPreviewTarget {
  uri: vscode.Uri;
  key: string;
  relativePath: string;
  edits: vscode.TextEdit[];
  preDoc: vscode.TextDocument;
  preVersion: number;
  preText: string;
  preEol: vscode.EndOfLine;
  safeToAutoSave: boolean;
  expectation: ProposedEditExpectation;
  tracker: TargetChangeTracker;
}

async function verifyPreviewEntryBaseline(
  entry: PreviewTextEditEntry,
  cleanDocUris?: ReadonlySet<string>
): Promise<
  | { ok: true; doc: vscode.TextDocument; safeToAutoSave: boolean }
  | { ok: false; reason: string }
> {
  const key = entry.uri.toString();
  const baseline = entry.baseline;
  const openDoc = findOpenDocument(entry.uri);

  if (baseline) {
    if (baseline.document && !baseline.document.isClosed && openDoc === baseline.document) {
      if (openDoc.version !== baseline.version) {
        return { ok: false, reason: 'document was modified since dry-run' };
      }
      if (openDoc.getText() !== baseline.text || openDoc.eol !== baseline.eol) {
        return { ok: false, reason: 'document content changed since dry-run' };
      }
      if (!baseline.wasDirty && openDoc.isDirty) {
        return { ok: false, reason: 'document has unsaved edits since dry-run' };
      }
      return {
        ok: true,
        doc: openDoc,
        safeToAutoSave: !baseline.wasDirty && !openDoc.isDirty,
      };
    }

    let currentDoc = openDoc;
    if (!currentDoc) {
      try {
        currentDoc = await vscode.workspace.openTextDocument(entry.uri);
      } catch {
        return { ok: false, reason: 'document could not be reopened' };
      }
    }

    if (currentDoc.isClosed) {
      return { ok: false, reason: 'document was closed' };
    }
    if (currentDoc.getText() !== baseline.text || currentDoc.eol !== baseline.eol) {
      return { ok: false, reason: 'document changed since dry-run' };
    }
    if (!baseline.wasDirty && currentDoc.isDirty) {
      return { ok: false, reason: 'document has unsaved edits since dry-run' };
    }

    return {
      ok: true,
      doc: currentDoc,
      safeToAutoSave: !baseline.wasDirty && !currentDoc.isDirty,
    };
  }

  let currentDoc = openDoc;
  if (!currentDoc) {
    try {
      currentDoc = await vscode.workspace.openTextDocument(entry.uri);
    } catch {
      return { ok: false, reason: 'document could not be opened' };
    }
  }
  if (currentDoc.isClosed) {
    return { ok: false, reason: 'document was closed' };
  }

  const wasCleanAtScan = cleanDocUris ? cleanDocUris.has(key) : !currentDoc.isDirty;
  return {
    ok: true,
    doc: currentDoc,
    safeToAutoSave: wasCleanAtScan && !currentDoc.isDirty,
  };
}

export async function applyCollectedPreviewEdits(
  entries: readonly PreviewTextEditEntry[],
  options: {
    needsConfirmation: boolean;
    label: string;
    cleanDocUris?: ReadonlySet<string>;
    saveAfterOrganize: boolean;
  }
): Promise<ApplyPreviewResult> {
  const byUri = new Map<string, PreviewTextEditEntry[]>();
  for (const entry of entries) {
    const key = entry.uri.toString();
    let bucket = byUri.get(key);
    if (!bucket) {
      bucket = [];
      byUri.set(key, bucket);
    }
    bucket.push(entry);
  }

  const proposedCount = byUri.size;
  const skippedConflicting: SkippedPreviewTarget[] = [];
  const skippedStale: SkippedPreviewTarget[] = [];
  const candidates: PreviewTextEditEntry[] = [];

  for (const bucket of byUri.values()) {
    if (bucket.length > 1) {
      const uri = bucket[0].uri;
      skippedConflicting.push({
        uri,
        relativePath: formatDisplayPath(uri),
        reason: 'multiple conflicting edit sets proposed for the same file',
      });
      continue;
    }
    candidates.push(bucket[0]);
  }

  const verifiedTargets = new Map<string, VerifiedPreviewTarget>();

  for (const entry of candidates) {
    const relativePath = formatDisplayPath(entry.uri);
    const verification = await verifyPreviewEntryBaseline(entry, options.cleanDocUris);
    if (!verification.ok) {
      skippedStale.push({
        uri: entry.uri,
        relativePath,
        reason: verification.reason,
      });
      continue;
    }

    const preDoc = verification.doc;
    const expectation = buildProposedEditExpectation(preDoc, entry.edits);
    const key = entry.uri.toString();
    verifiedTargets.set(key, {
      uri: entry.uri,
      key,
      relativePath,
      edits: entry.edits,
      preDoc,
      preVersion: preDoc.version,
      preText: preDoc.getText(),
      preEol: preDoc.eol,
      safeToAutoSave: verification.safeToAutoSave,
      expectation,
      tracker: createTargetChangeTracker(),
    });
  }

  // Final synchronous re-verification right before handing off to applyEdit so
  // changes occurring while earlier closed documents were reopened are caught.
  for (const [key, target] of verifiedTargets.entries()) {
    const liveDoc = findOpenDocument(target.uri);
    const stillValid =
      liveDoc !== undefined &&
      liveDoc === target.preDoc &&
      !liveDoc.isClosed &&
      liveDoc.version === target.preVersion &&
      liveDoc.getText() === target.preText &&
      liveDoc.eol === target.preEol &&
      (!target.safeToAutoSave || !liveDoc.isDirty);

    if (!stillValid) {
      verifiedTargets.delete(key);
      skippedStale.push({
        uri: target.uri,
        relativePath: target.relativePath,
        reason: 'document changed before applying batch',
      });
    }
  }

  if (verifiedTargets.size === 0) {
    return {
      applied: false,
      proposedCount,
      verifiedCount: 0,
      appliedCount: 0,
      countReliable: true,
      savedCount: 0,
      skippedStale,
      skippedConflicting,
      saveFailedPaths: [],
      leftUnsavedPaths: [],
      interveningEditPaths: [],
      applyMs: 0,
      saveMs: 0,
    };
  }

  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const target of verifiedTargets.values()) {
    if (options.needsConfirmation) {
      const metadata: vscode.WorkspaceEditEntryMetadata = {
        needsConfirmation: true,
        label: options.label,
      };
      workspaceEdit.set(
        target.uri,
        target.edits.map((te): [vscode.TextEdit, vscode.WorkspaceEditEntryMetadata] => [
          te,
          metadata,
        ])
      );
    } else {
      workspaceEdit.set(target.uri, target.edits);
    }
  }

  const hasChangeListener = typeof vscode.workspace.onDidChangeTextDocument === 'function';
  const changeListener = hasChangeListener
    ? vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length === 0) {
          return;
        }
        const target = verifiedTargets.get(event.document.uri.toString());
        if (!target) {
          return;
        }
        recordTargetChangeEvent(event, target.preText, target.expectation, target.tracker);
      })
    : undefined;

  let applied: boolean;
  let applyMs = 0;
  const applyStart = performance.now();
  try {
    applied = await vscode.workspace.applyEdit(workspaceEdit);
  } finally {
    applyMs = performance.now() - applyStart;
    changeListener?.dispose();
  }

  if (!applied) {
    return {
      applied: false,
      proposedCount,
      verifiedCount: verifiedTargets.size,
      appliedCount: 0,
      countReliable: true,
      savedCount: 0,
      skippedStale,
      skippedConflicting,
      saveFailedPaths: [],
      leftUnsavedPaths: [],
      interveningEditPaths: [],
      applyMs,
      saveMs: 0,
    };
  }

  let appliedCount = 0;
  let countReliable = true;
  let savedCount = 0;
  let saveMs = 0;
  const saveFailedPaths: string[] = [];
  const leftUnsavedPaths: string[] = [];
  const interveningEditPaths: string[] = [];

  for (const target of verifiedTargets.values()) {
    const currentDoc = findOpenDocument(target.uri);
    const { tracker, expectation } = target;

    if (!currentDoc) {
      if (tracker.textChangeEvents > 0 || target.preDoc.isClosed) {
        countReliable = false;
      }
      continue;
    }

    const currentText = currentDoc.getText();
    const currentEol = currentDoc.eol;
    const textOrEolChanged = currentText !== target.preText || currentEol !== target.preEol;
    const versionChanged =
      currentDoc !== target.preDoc || currentDoc.version !== target.preVersion;

    if (!textOrEolChanged && !versionChanged && tracker.textChangeEvents === 0) {
      continue;
    }

    const matchesFull =
      currentEol === expectation.effectiveEol &&
      ((expectation.expectedNormalizedText !== null &&
        currentText === expectation.expectedNormalizedText) ||
        (expectation.expectedRawText !== null && currentText === expectation.expectedRawText));

    let isCleanApply = false;
    if (textOrEolChanged) {
      if (hasChangeListener) {
        if (tracker.textChangeEvents === 0) {
          // Pure EOL change (setEndOfLine) can occur with zero contentChanges.
          isCleanApply = matchesFull && !tracker.lastEventHadUndoOrRedo;
        } else {
          isCleanApply =
            tracker.textChangeEvents === 1 &&
            tracker.allEventsMatchedProposed &&
            !tracker.lastEventHadUndoOrRedo &&
            (tracker.matchedAnyProposed || matchesFull);
        }
      } else {
        isCleanApply = matchesFull;
      }
    }

    if (isCleanApply) {
      appliedCount++;
      if (options.saveAfterOrganize && target.safeToAutoSave && currentDoc.isDirty) {
        const saveStart = performance.now();
        try {
          const saved = await currentDoc.save();
          if (saved) {
            savedCount++;
          } else {
            saveFailedPaths.push(target.relativePath);
          }
        } catch {
          saveFailedPaths.push(target.relativePath);
        } finally {
          saveMs += performance.now() - saveStart;
        }
      } else if (currentDoc.isDirty) {
        leftUnsavedPaths.push(target.relativePath);
      }
    } else {
      countReliable = false;
      interveningEditPaths.push(target.relativePath);
    }
  }

  return {
    applied: true,
    proposedCount,
    verifiedCount: verifiedTargets.size,
    appliedCount,
    countReliable,
    savedCount,
    skippedStale,
    skippedConflicting,
    saveFailedPaths,
    leftUnsavedPaths,
    interveningEditPaths,
    applyMs,
    saveMs,
  };
}

function logApplyPreviewDetails(
  output: vscode.OutputChannel,
  applyResult: ApplyPreviewResult
): void {
  for (const skipped of applyResult.skippedConflicting) {
    output.appendLine(`⚠ Skipped ${skipped.relativePath} — ${skipped.reason}.`);
  }
  for (const skipped of applyResult.skippedStale) {
    output.appendLine(`⚠ Skipped ${skipped.relativePath} — ${skipped.reason}.`);
  }
  for (const filePath of applyResult.interveningEditPaths) {
    output.appendLine(
      `⚠ Skipped auto-save for ${filePath} (modified outside preview during review).`
    );
  }
  for (const filePath of applyResult.saveFailedPaths) {
    output.appendLine(`⚠ Failed to save ${filePath} automatically.`);
  }
}

function formatSummaryCounts(counts: {
  dryRun: boolean;
  modifiedCount: number;
  unchangedCount: number;
  noActionCount: number;
  commandOnlyCount: number;
  saveFailedCount: number;
  errorCount: number;
}): string {
  const parts: string[] = [
    `${counts.modifiedCount} ${counts.dryRun ? 'would be modified' : 'modified'}`,
    `${counts.unchangedCount} unchanged`,
  ];
  if (counts.noActionCount > 0) {
    parts.push(`${counts.noActionCount} no action`);
  }
  if (counts.commandOnlyCount > 0) {
    parts.push(`${counts.commandOnlyCount} command-only`);
  }
  if (counts.saveFailedCount > 0) {
    parts.push(`${counts.saveFailedCount} save failed`);
  }
  parts.push(`${counts.errorCount} error(s)`);
  return parts.join(', ');
}

function writeEarlyDiscoveryReport(
  output: vscode.OutputChannel,
  progressTitle: string,
  modeKindValue: string,
  showOutputOnRun: boolean,
  discovered: DiscoveredFiles
): void {
  output.clear();
  if (showOutputOnRun) {
    output.show(true);
  }
  const divider = '─'.repeat(68);
  output.appendLine(divider);
  output.appendLine(`▶ ${progressTitle} — ${new Date().toLocaleTimeString()} (0 file(s))`);
  output.appendLine(`Mode: ${modeKindValue}`);
  output.appendLine(divider);
  if (discovered.fatalMessage) {
    output.appendLine(`⚠ Warning: ${discovered.fatalMessage}`);
  }
  for (const warning of discovered.warnings) {
    if (warning !== discovered.fatalMessage) {
      output.appendLine(`⚠ Warning: ${warning}`);
    }
  }
  if (discovered.earlyMessage) {
    output.appendLine(`ℹ Note: ${discovered.earlyMessage.text}`);
  }
  output.appendLine(
    `ℹ Note: Timings — discovery ${formatDurationMs(discovered.timings.discoveryMs)} (git ${formatDurationMs(discovered.timings.gitMs)})`
  );
  output.appendLine(divider);
}

/**
 * Finds target workspace files and runs (or dry-runs) the configured import action.
 */
export async function runOrganizeImports(
  output: vscode.OutputChannel,
  runOptions: RunOrganizeOptions
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    void vscode.window.showWarningMessage('No workspace folder is open.');
    return;
  }

  const dryRun = runOptions.dryRun ?? false;
  const config = vscode.workspace.getConfiguration('organizeImportsAll');
  const ignoredFolders = config.get<string[]>('ignoredFolders') ?? [];
  const resolvedMode = resolveActionKindValue(
    runOptions.actionMode ?? config.get<string>('actionMode')
  );
  const targetKind =
    resolvedMode.mode === 'sortImports'
      ? vscode.CodeActionKind.Source.append('sortImports')
      : resolvedMode.mode === 'removeUnusedImports'
        ? vscode.CodeActionKind.Source.append('removeUnusedImports')
        : vscode.CodeActionKind.SourceOrganizeImports;
  const saveAfterOrganize = config.get<boolean>('saveAfterOrganize') ?? true;
  const showOutputOnRun = config.get<boolean>('showOutputOnRun') ?? true;
  const outputVerbosity: OutputVerbosity = resolveOutputVerbosity(
    config.get<string>('outputVerbosity')
  );

  const progressTitle = getHeaderTitle(runOptions.scope, dryRun);

  interface RunSummary {
    cancelled: boolean;
    modifiedCount: number;
    unchangedCount: number;
    noActionCount: number;
    commandOnlyCount: number;
    saveFailedCount: number;
    processedCount: number;
    errorCount: number;
    previewEdits: PreviewTextEditEntry[];
    cleanDocUris: Set<string>;
    discoveryWarnings: string[];
    fatalMessage?: string;
    earlyMessage?: { kind: 'info' | 'warning'; text: string };
    timings: PhaseTimings;
  }

  const zeroTimings = (): PhaseTimings => ({
    discoveryMs: 0,
    gitMs: 0,
    openMs: 0,
    providerMs: 0,
    retryWaitMs: 0,
    retryCount: 0,
    applyMs: 0,
    saveMs: 0,
  });

  const emptySummary = (overrides?: Partial<RunSummary>): RunSummary => ({
    cancelled: false,
    modifiedCount: 0,
    unchangedCount: 0,
    noActionCount: 0,
    commandOnlyCount: 0,
    saveFailedCount: 0,
    processedCount: 0,
    errorCount: 0,
    previewEdits: [],
    cleanDocUris: new Set(),
    discoveryWarnings: [],
    timings: zeroTimings(),
    ...overrides,
  });

  const summary = await vscode.window.withProgress<RunSummary>(
    {
      location: vscode.ProgressLocation.Notification,
      title: progressTitle,
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: 'Scanning workspace files...' });

      const discovered = await discoverTargetFiles(runOptions.scope, workspaceFolders, token);

      const timings: PhaseTimings = {
        ...zeroTimings(),
        discoveryMs: discovered.timings.discoveryMs,
        gitMs: discovered.timings.gitMs,
      };

      if (discovered.status === 'cancelled' || token.isCancellationRequested) {
        return emptySummary({ cancelled: true, timings });
      }

      if (discovered.status === 'fatal') {
        writeEarlyDiscoveryReport(
          output,
          progressTitle,
          resolvedMode.kindValue,
          showOutputOnRun,
          discovered
        );
        return emptySummary({
          fatalMessage: discovered.fatalMessage ?? 'File discovery failed.',
          discoveryWarnings: discovered.warnings,
          timings,
        });
      }

      if (discovered.earlyMessage) {
        if (discovered.status === 'incomplete' && discovered.warnings.length > 0) {
          writeEarlyDiscoveryReport(
            output,
            progressTitle,
            resolvedMode.kindValue,
            showOutputOnRun,
            discovered
          );
        }
        return emptySummary({
          earlyMessage: discovered.earlyMessage,
          discoveryWarnings: discovered.warnings,
          timings,
        });
      }

      const files = [...discovered.files].sort((a, b) => a.fsPath.localeCompare(b.fsPath));
      if (files.length === 0) {
        const earlyMessage = {
          kind: discovered.warnings.length > 0 ? ('warning' as const) : ('info' as const),
          text: 'No matching code files found.',
        };
        if (discovered.warnings.length > 0) {
          writeEarlyDiscoveryReport(output, progressTitle, resolvedMode.kindValue, showOutputOnRun, {
            ...discovered,
            earlyMessage,
          });
        }
        return emptySummary({
          earlyMessage,
          discoveryWarnings: discovered.warnings,
          timings,
        });
      }

      const startTime = Date.now();
      output.clear();
      if (showOutputOnRun) {
        output.show(true);
      }

      const divider = '─'.repeat(68);
      output.appendLine(divider);
      output.appendLine(
        `▶ ${progressTitle} — ${new Date().toLocaleTimeString()} (${files.length} file(s))`
      );
      output.appendLine(`Mode: ${resolvedMode.kindValue}`);
      if (runOptions.scope.kind === 'gitBranch') {
        output.appendLine(`ℹ Note: Base ref ${runOptions.scope.baseRef.trim()} (merge-base..HEAD on current buffers)`);
      }
      if (outputVerbosity === 'changesOnly') {
        output.appendLine('ℹ Note: Output verbosity is changesOnly (hiding unchanged and no-action files).');
      }
      if (ignoredFolders.length > 0) {
        output.appendLine(`Ignored folders: ${ignoredFolders.join(', ')}`);
      }
      if (discovered.gitIgnoredCount > 0) {
        output.appendLine(`Skipped by .gitignore: ${discovered.gitIgnoredCount} file(s)`);
      }
      for (const warning of discovered.warnings) {
        output.appendLine(`⚠ Warning: ${warning}`);
      }
      output.appendLine(divider);

      const allowedTargetUris = new Set(files.map((u) => u.toString()));
      const warmedLanguages = new Set<string>();
      const increment = 100 / files.length;
      const previewEdits: PreviewTextEditEntry[] = [];
      const cleanDocUris = new Set<string>();
      let modifiedCount = 0;
      let unsavedModifiedCount = 0;
      let unchangedCount = 0;
      let noActionCount = 0;
      let commandOnlyCount = 0;
      let saveFailedCount = 0;
      let processedCount = 0;
      let errorCount = 0;

      const logStatusIfVisible = (
        index: number,
        status: OrganizeDocumentOutcome,
        relativePath: string,
        errorMessage?: string
      ): void => {
        if (!shouldLogFileStatus(status, outputVerbosity)) {
          return;
        }
        output.appendLine(
          formatFileStatusLine({
            index,
            total: files.length,
            status,
            relativePath,
            errorMessage,
          })
        );
      };

      for (let i = 0; i < files.length; i++) {
        if (token.isCancellationRequested) {
          break;
        }

        const uri = files[i];
        const relativePath = formatDisplayPath(uri);
        progress.report({
          message: `(${i + 1}/${files.length}) ${relativePath}`,
          increment,
        });

        try {
          const openStart = performance.now();
          const doc = await vscode.workspace.openTextDocument(uri);
          timings.openMs += performance.now() - openStart;

          if (token.isCancellationRequested) {
            break;
          }

          const isFirstForLanguage = !warmedLanguages.has(doc.languageId);
          warmedLanguages.add(doc.languageId);

          const result = await organizeImportsInDocument(doc, {
            targetKind,
            isFirstForLanguage,
            saveAfterOrganize,
            dryRun,
            token,
            allowedTargetUris,
          });

          if (result.timings) {
            timings.openMs += result.timings.openMs;
            timings.providerMs += result.timings.providerMs;
            timings.retryWaitMs += result.timings.retryWaitMs;
            timings.retryCount += result.timings.retryCount;
            timings.applyMs += result.timings.applyMs;
            timings.saveMs += result.timings.saveMs;
          }

          if (result.cancelled) {
            break;
          }

          processedCount++;

          switch (result.outcome) {
            case 'would-modify':
              modifiedCount++;
              previewEdits.push(...result.previewEdits);
              if (!result.wasDirty) {
                cleanDocUris.add(uri.toString());
              }
              logStatusIfVisible(i + 1, 'would-modify', relativePath);
              break;
            case 'modified':
              modifiedCount++;
              if (result.leftUnsaved) {
                unsavedModifiedCount++;
              }
              logStatusIfVisible(i + 1, 'modified', relativePath);
              break;
            case 'save-failed':
              if (result.modified) {
                modifiedCount++;
              }
              saveFailedCount++;
              logStatusIfVisible(i + 1, 'save-failed', relativePath, result.errorMessage);
              break;
            case 'command-only':
              commandOnlyCount++;
              logStatusIfVisible(
                i + 1,
                'command-only',
                relativePath,
                result.errorMessage ?? 'action cannot be previewed'
              );
              break;
            case 'no-action':
              noActionCount++;
              logStatusIfVisible(i + 1, 'no-action', relativePath);
              break;
            case 'error':
              errorCount++;
              logStatusIfVisible(i + 1, 'error', relativePath, result.errorMessage);
              break;
            case 'unchanged':
              unchangedCount++;
              logStatusIfVisible(i + 1, 'unchanged', relativePath);
              break;
          }
        } catch (err) {
          processedCount++;
          errorCount++;
          const msg = err instanceof Error ? err.message : String(err);
          logStatusIfVisible(i + 1, 'error', relativePath, msg);
        }
      }

      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
      output.appendLine(divider);

      const countsText = formatSummaryCounts({
        dryRun,
        modifiedCount,
        unchangedCount,
        noActionCount,
        commandOnlyCount,
        saveFailedCount,
        errorCount,
      });

      if (token.isCancellationRequested) {
        output.appendLine(
          `⚠ Cancelled after ${elapsedSec}s — ${countsText} (${processedCount}/${files.length} processed)`
        );
        output.appendLine(formatPhaseTimingsNote(timings, dryRun));
        return {
          cancelled: true,
          modifiedCount,
          unchangedCount,
          noActionCount,
          commandOnlyCount,
          saveFailedCount,
          processedCount,
          errorCount,
          previewEdits,
          cleanDocUris,
          discoveryWarnings: discovered.warnings,
          timings,
        };
      }

      if (dryRun) {
        output.appendLine(
          `ℹ Dry run in ${elapsedSec}s — ${countsText} (${processedCount}/${files.length} scanned)`
        );
        output.appendLine(formatPhaseTimingsNote(timings, true));
        if (commandOnlyCount > 0) {
          output.appendLine(
            `ℹ Note: ${commandOnlyCount} file(s) returned command-only action(s) whose effects cannot be previewed in dry-run.`
          );
        }
        if (modifiedCount > 0 && saveAfterOrganize) {
          output.appendLine(
            'ℹ Note: Applying with saveAfterOrganize enabled may also trigger format-on-save or other save actions.'
          );
        }
      } else {
        output.appendLine(
          `✔ Completed in ${elapsedSec}s — ${countsText} (${processedCount}/${files.length} processed)`
        );
        output.appendLine(formatPhaseTimingsNote(timings, false));
        if (unsavedModifiedCount > 0) {
          output.appendLine(
            `ℹ Note: ${unsavedModifiedCount} modified file(s) remain unsaved in the editor (had prior unsaved changes, intervening edits, or saveAfterOrganize is disabled).`
          );
        }
        if (saveFailedCount > 0) {
          output.appendLine(
            `⚠ Warning: ${saveFailedCount} modified file(s) could not be saved automatically.`
          );
        }
      }

      if (discovered.warnings.length > 0) {
        output.appendLine(
          `⚠ Warning: Discovery was incomplete (${discovered.warnings.length} warning(s)); check logs above for details.`
        );
      }

      return {
        cancelled: false,
        modifiedCount,
        unchangedCount,
        noActionCount,
        commandOnlyCount,
        saveFailedCount,
        processedCount,
        errorCount,
        previewEdits,
        cleanDocUris,
        discoveryWarnings: discovered.warnings,
        timings,
      };
    }
  );

  if (summary.fatalMessage) {
    const pick = await vscode.window.showWarningMessage(summary.fatalMessage, 'Show Logs');
    if (pick === 'Show Logs') {
      output.show(true);
    }
    return;
  }

  if (summary.earlyMessage) {
    if (summary.discoveryWarnings.length > 0) {
      const pick = await vscode.window.showWarningMessage(
        `${summary.earlyMessage.text} Discovery was incomplete (${summary.discoveryWarnings.length} warning(s)).`,
        'Show Logs'
      );
      if (pick === 'Show Logs') {
        output.show(true);
      }
      return;
    }
    if (summary.earlyMessage.kind === 'warning') {
      void vscode.window.showWarningMessage(summary.earlyMessage.text);
    } else {
      void vscode.window.showInformationMessage(summary.earlyMessage.text);
    }
    return;
  }

  if (summary.cancelled) {
    if (summary.processedCount === 0) {
      void vscode.window.showInformationMessage('Organize imports cancelled.');
    } else {
      const verb = dryRun ? 'would be modified' : 'updated';
      void vscode.window.showInformationMessage(
        `Organize imports cancelled (${summary.modifiedCount} of ${summary.processedCount} processed file(s) ${verb}).`
      );
    }
    return;
  }

  const hasDiscoveryWarnings = summary.discoveryWarnings.length > 0;

  if (dryRun) {
    if (summary.modifiedCount === 0) {
      if (summary.errorCount > 0 || hasDiscoveryWarnings) {
        const issueParts: string[] = [];
        if (summary.errorCount > 0) {
          issueParts.push(`${summary.errorCount} error(s)`);
        }
        if (hasDiscoveryWarnings) {
          issueParts.push(
            `incomplete discovery (${summary.discoveryWarnings.length} warning(s))`
          );
        }
        const pick = await vscode.window.showWarningMessage(
          `Dry run finished with ${issueParts.join(' and ')} and no previewable changes.`,
          'Show Logs'
        );
        if (pick === 'Show Logs') {
          output.show(true);
        }
      } else if (summary.commandOnlyCount > 0) {
        const details: string[] = [
          `${summary.commandOnlyCount} file(s) returned command-only action(s) that cannot be previewed`,
        ];
        if (summary.noActionCount > 0) {
          details.push(`${summary.noActionCount} returned no matching action`);
        }
        const pick = await vscode.window.showInformationMessage(
          `Dry run complete: no previewable text changes (${details.join('; ')}).`,
          'Show Logs'
        );
        if (pick === 'Show Logs') {
          output.show(true);
        }
      } else if (summary.noActionCount === summary.processedCount) {
        const pick = await vscode.window.showInformationMessage(
          `Dry run complete: no matching import actions were returned for ${summary.processedCount} file(s).`,
          'Show Logs'
        );
        if (pick === 'Show Logs') {
          output.show(true);
        }
      } else if (summary.noActionCount > 0) {
        void vscode.window.showInformationMessage(
          `Dry run complete: no text changes in ${summary.unchangedCount} file(s); ${summary.noActionCount} file(s) returned no matching action.`
        );
      } else {
        void vscode.window.showInformationMessage(
          'Dry run complete: all files already have organized imports.'
        );
      }
      return;
    }

    const dryRunNotes: string[] = [];
    if (summary.commandOnlyCount > 0) {
      dryRunNotes.push(`${summary.commandOnlyCount} command-only action(s) cannot be previewed`);
    }
    if (hasDiscoveryWarnings) {
      dryRunNotes.push(`incomplete discovery — ${summary.discoveryWarnings.length} warning(s)`);
    }
    const notesSuffix = dryRunNotes.length > 0 ? ` (${dryRunNotes.join('; ')})` : '';
    const promptFn = hasDiscoveryWarnings
      ? vscode.window.showWarningMessage
      : vscode.window.showInformationMessage;
    const selection = await promptFn(
      `Dry run: ${summary.modifiedCount} of ${summary.processedCount} file(s) would be modified${notesSuffix}.`,
      'Open Refactor Preview',
      'Apply All'
    );

    if (selection === 'Open Refactor Preview' || selection === 'Apply All') {
      const needsConfirmation = selection === 'Open Refactor Preview';
      const applyResult = await applyCollectedPreviewEdits(summary.previewEdits, {
        needsConfirmation,
        label: resolvedMode.label,
        cleanDocUris: summary.cleanDocUris,
        saveAfterOrganize,
      });

      logApplyPreviewDetails(output, applyResult);

      const skippedTotal =
        applyResult.skippedStale.length + applyResult.skippedConflicting.length;

      if (applyResult.verifiedCount === 0) {
        output.appendLine(
          '⚠ No previewed files could be applied because they changed or conflicted since dry-run.'
        );
        const pick = await vscode.window.showWarningMessage(
          'No previewed files could be applied because they changed since the dry-run. Please run dry-run again.',
          'Show Logs'
        );
        if (pick === 'Show Logs') {
          output.show(true);
        }
        return;
      }

      if (!applyResult.applied) {
        if (needsConfirmation) {
          output.appendLine('ℹ Refactor Preview was cancelled; no changes were applied.');
        } else {
          output.appendLine('✖ Failed to apply changes.');
          const pick = await vscode.window.showWarningMessage(
            'Failed to apply previewed changes.',
            'Show Logs'
          );
          if (pick === 'Show Logs') {
            output.show(true);
          }
        }
        return;
      }

      let appliedSummaryText: string;
      if (applyResult.countReliable) {
        if (applyResult.appliedCount === 0) {
          appliedSummaryText = 'No previewed changes were applied.';
          output.appendLine(`ℹ ${appliedSummaryText}`);
        } else if (
          applyResult.appliedCount === applyResult.proposedCount &&
          skippedTotal === 0
        ) {
          appliedSummaryText = `Applied changes to ${applyResult.appliedCount} file(s).`;
          output.appendLine(`✔ ${appliedSummaryText}`);
        } else {
          appliedSummaryText = `Applied changes to ${applyResult.appliedCount} of ${applyResult.proposedCount} previewed file(s).`;
          output.appendLine(`✔ ${appliedSummaryText}`);
        }
      } else {
        appliedSummaryText = 'Applied previewed changes.';
        output.appendLine(`✔ ${appliedSummaryText}`);
      }

      if (applyResult.applyMs !== undefined || applyResult.saveMs !== undefined) {
        output.appendLine(
          `ℹ Note: Preview apply timings — apply ${formatDurationMs(applyResult.applyMs ?? 0)}, save ${formatDurationMs(applyResult.saveMs ?? 0)}`
        );
      }

      if (applyResult.leftUnsavedPaths.length > 0) {
        output.appendLine(
          `ℹ Note: ${applyResult.leftUnsavedPaths.length} modified file(s) remain unsaved in the editor (had prior unsaved changes or saveAfterOrganize is disabled).`
        );
      }

      const warnings: string[] = [];
      if (skippedTotal > 0) {
        warnings.push(`${skippedTotal} skipped as stale/conflicting`);
      }
      if (applyResult.interveningEditPaths.length > 0) {
        warnings.push(
          `${applyResult.interveningEditPaths.length} had intervening edits and were not auto-saved`
        );
      }
      if (applyResult.saveFailedPaths.length > 0) {
        warnings.push(`failed to save ${applyResult.saveFailedPaths.length} file(s)`);
      }

      if (warnings.length > 0) {
        const pick = await vscode.window.showWarningMessage(
          `${appliedSummaryText.replace(/\.$/, '')} (${warnings.join('; ')}).`,
          'Show Logs'
        );
        if (pick === 'Show Logs') {
          output.show(true);
        }
      } else if (!needsConfirmation) {
        void vscode.window.showInformationMessage(appliedSummaryText);
      }
    }
    return;
  }

  if (summary.errorCount > 0 || summary.saveFailedCount > 0 || hasDiscoveryWarnings) {
    const issueParts: string[] = [];
    if (summary.errorCount > 0) {
      issueParts.push(`${summary.errorCount} error(s)`);
    }
    if (summary.saveFailedCount > 0) {
      issueParts.push(`${summary.saveFailedCount} failed save(s)`);
    }
    if (hasDiscoveryWarnings) {
      issueParts.push(`incomplete discovery (${summary.discoveryWarnings.length} warning(s))`);
    }
    const selection = await vscode.window.showWarningMessage(
      `Organized imports in ${summary.modifiedCount} of ${summary.processedCount} file(s), with ${issueParts.join(' and ')}.`,
      'Show Logs'
    );
    if (selection === 'Show Logs') {
      output.show(true);
    }
    return;
  }

  if (summary.modifiedCount === 0 && summary.noActionCount === summary.processedCount) {
    void vscode.window.showInformationMessage(
      `No matching import actions were returned for ${summary.processedCount} file(s).`
    );
    return;
  }

  const noActionSuffix =
    summary.noActionCount > 0
      ? ` (${summary.noActionCount} returned no matching action)`
      : '';
  void vscode.window.showInformationMessage(
    `Organized imports in ${summary.modifiedCount} of ${summary.processedCount} file(s)${noActionSuffix}.`
  );
}
