import * as path from 'node:path';
import * as vscode from 'vscode';
import { filterGitIgnoredFiles, getGitChangedFiles } from './git';
import {
  buildExcludeGlob,
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_INCLUDE_GLOB,
  formatFileStatusLine,
  OffsetTextEdit,
  resolveActionKindValue,
  wouldOffsetEditsChangeText,
} from './glob';

const ITEM_RESOLVE_COUNT = 10;
const COLD_START_DELAYS_MS = [250, 500, 1000] as const;

type CodeActionResult = vscode.CodeAction | vscode.Command;

export type OrganizeScope =
  | { kind: 'workspace' }
  | { kind: 'folders'; folders: readonly vscode.Uri[] }
  | { kind: 'gitChanged' };

export interface RunOrganizeOptions {
  scope: OrganizeScope;
  dryRun?: boolean;
}

export interface PreviewTextEditEntry {
  uri: vscode.Uri;
  edits: vscode.TextEdit[];
}

export interface OrganizeDocumentResult {
  modified: boolean;
  languageId: string;
  wasDirty: boolean;
  leftUnsaved: boolean;
  previewEdits: PreviewTextEditEntry[];
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

function extractEffectiveEditEntries(
  doc: vscode.TextDocument,
  edit: vscode.WorkspaceEdit
): PreviewTextEditEntry[] {
  const entries: PreviewTextEditEntry[] = [];
  const docUriString = doc.uri.toString();
  let docText: string | undefined;

  for (const [editUri, textEdits] of edit.entries()) {
    if (editUri.toString() === docUriString) {
      const nonTrivial = textEdits.filter((te) => doc.getText(te.range) !== te.newText);
      if (nonTrivial.length === 0) {
        continue;
      }

      docText ??= doc.getText();
      const offsetEdits: OffsetTextEdit[] = nonTrivial.map((te) => ({
        startOffset: doc.offsetAt(te.range.start),
        endOffset: doc.offsetAt(te.range.end),
        newText: te.newText,
      }));
      if (!wouldOffsetEditsChangeText(docText, offsetEdits)) {
        continue;
      }

      entries.push({ uri: editUri, edits: nonTrivial });
    } else {
      const meaningful = textEdits.filter((te) => te.newText.length > 0 || !te.range.isEmpty);
      if (meaningful.length > 0) {
        entries.push({ uri: editUri, edits: meaningful });
      }
    }
  }

  return entries;
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
  uri: vscode.Uri,
  options: {
    targetKind: vscode.CodeActionKind;
    isFirstForLanguage: boolean;
    saveAfterOrganize: boolean;
    dryRun: boolean;
    token: vscode.CancellationToken;
  }
): Promise<OrganizeDocumentResult> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const wasDirty = doc.isDirty;
  const initialText = doc.getText();
  const initialEol = doc.eol;

  let actions = await fetchCodeActions(doc, options.targetKind);

  // Give a newly activated language server (e.g. tsserver, Pylance) time to
  // register its code action provider on the first file of that language.
  if (options.isFirstForLanguage && (!actions || actions.length === 0)) {
    for (const delayMs of COLD_START_DELAYS_MS) {
      if (options.token.isCancellationRequested) {
        break;
      }
      await delayWithCancellation(delayMs, options.token);
      if (options.token.isCancellationRequested) {
        break;
      }
      actions = await fetchCodeActions(doc, options.targetKind);
      if (actions && actions.length > 0) {
        break;
      }
    }
  }

  const orderedActions = prioritizeActions(actions ?? []);
  const previewEdits: PreviewTextEditEntry[] = [];

  if (options.dryRun) {
    for (const item of orderedActions) {
      if (options.token.isCancellationRequested) {
        break;
      }
      if (isCommandItem(item) || !isMatchingActionKind(item, options.targetKind)) {
        continue;
      }
      if (!item.edit) {
        continue;
      }
      const effective = extractEffectiveEditEntries(doc, item.edit);
      if (effective.length > 0) {
        previewEdits.push(...effective);
        break;
      }
    }

    return {
      modified: previewEdits.length > 0,
      languageId: doc.languageId,
      wasDirty,
      leftUnsaved: false,
      previewEdits,
    };
  }

  for (const item of orderedActions) {
    if (options.token.isCancellationRequested) {
      break;
    }

    if (isCommandItem(item)) {
      await vscode.commands.executeCommand(item.command, ...(item.arguments ?? []));
      break;
    }

    if (!isMatchingActionKind(item, options.targetKind)) {
      continue;
    }

    if (item.edit) {
      const effective = extractEffectiveEditEntries(doc, item.edit);
      if (effective.length === 0) {
        continue;
      }

      const filteredEdit = new vscode.WorkspaceEdit();
      for (const entry of effective) {
        filteredEdit.set(entry.uri, entry.edits);
      }
      await vscode.workspace.applyEdit(filteredEdit);

      if (item.command) {
        await vscode.commands.executeCommand(
          item.command.command,
          ...(item.command.arguments ?? [])
        );
      }
      break;
    }

    if (item.command) {
      await vscode.commands.executeCommand(
        item.command.command,
        ...(item.command.arguments ?? [])
      );
      break;
    }
  }

  // Save before checking whether text changed so formatOnSave / codeActionsOnSave
  // that revert purely stylistic edits do not inflate the modified file count.
  if (options.saveAfterOrganize && !wasDirty && doc.isDirty) {
    await doc.save();
  }

  const modified = doc.getText() !== initialText || doc.eol !== initialEol;
  const leftUnsaved = modified && doc.isDirty;

  return { modified, languageId: doc.languageId, wasDirty, leftUnsaved, previewEdits: [] };
}

async function applyGitIgnoreFilter(
  uris: readonly vscode.Uri[],
  fallbackRoot: string | undefined
): Promise<{ files: vscode.Uri[]; gitIgnoredCount: number }> {
  const groups = new Map<string, vscode.Uri[]>();

  for (const uri of uris) {
    const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? fallbackRoot ?? '';
    let bucket = groups.get(root);
    if (!bucket) {
      bucket = [];
      groups.set(root, bucket);
    }
    bucket.push(uri);
  }

  const keptPaths = new Set<string>();
  let gitIgnoredCount = 0;

  for (const [root, groupUris] of groups.entries()) {
    if (!root) {
      for (const uri of groupUris) {
        keptPaths.add(path.resolve(uri.fsPath));
      }
      continue;
    }

    const filtered = await filterGitIgnoredFiles(
      root,
      groupUris.map((u) => u.fsPath)
    );
    gitIgnoredCount += filtered.ignoredCount;
    for (const keptPath of filtered.kept) {
      keptPaths.add(path.resolve(keptPath));
    }
  }

  return {
    files: uris.filter((uri) => keptPaths.has(path.resolve(uri.fsPath))),
    gitIgnoredCount,
  };
}

interface DiscoveredFiles {
  files: vscode.Uri[];
  gitIgnoredCount: number;
  earlyMessage?: { kind: 'info' | 'warning'; text: string };
}

async function discoverTargetFiles(
  scope: OrganizeScope,
  includeGlob: string,
  excludeGlob: string | undefined,
  useGitIgnore: boolean,
  token: vscode.CancellationToken
): Promise<DiscoveredFiles> {
  if (scope.kind === 'workspace') {
    const candidates = await vscode.workspace.findFiles(includeGlob, excludeGlob, undefined, token);
    if (token.isCancellationRequested) {
      return { files: [], gitIgnoredCount: 0 };
    }
    if (!useGitIgnore) {
      return { files: candidates, gitIgnoredCount: 0 };
    }
    return applyGitIgnoreFilter(candidates, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  }

  if (scope.kind === 'folders') {
    const byPath = new Map<string, vscode.Uri>();
    for (const folderUri of scope.folders) {
      if (token.isCancellationRequested) {
        return { files: [], gitIgnoredCount: 0 };
      }
      const pattern = new vscode.RelativePattern(folderUri, includeGlob);
      const found = await vscode.workspace.findFiles(pattern, excludeGlob, undefined, token);
      for (const uri of found) {
        byPath.set(path.resolve(uri.fsPath), uri);
      }
    }
    const candidates = Array.from(byPath.values());
    if (token.isCancellationRequested || !useGitIgnore) {
      return { files: candidates, gitIgnoredCount: 0 };
    }
    return applyGitIgnoreFilter(candidates, scope.folders[0]?.fsPath);
  }

  // scope.kind === 'gitChanged'
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const repoResults = await Promise.all(
    workspaceFolders.map((wf) => getGitChangedFiles(wf.uri.fsPath))
  );

  if (!repoResults.some((res) => res.isRepo)) {
    return {
      files: [],
      gitIgnoredCount: 0,
      earlyMessage: {
        kind: 'warning',
        text: 'Current workspace is not a Git repository.',
      },
    };
  }

  const changedSet = new Set<string>();
  for (const res of repoResults) {
    for (const absPath of res.files) {
      changedSet.add(path.resolve(absPath));
    }
  }

  if (changedSet.size === 0) {
    return {
      files: [],
      gitIgnoredCount: 0,
      earlyMessage: {
        kind: 'info',
        text: 'No Git changed or untracked files found.',
      },
    };
  }

  const candidates = await vscode.workspace.findFiles(includeGlob, excludeGlob, undefined, token);
  if (token.isCancellationRequested) {
    return { files: [], gitIgnoredCount: 0 };
  }

  const files = candidates.filter((uri) => changedSet.has(path.resolve(uri.fsPath)));
  if (files.length === 0) {
    return {
      files: [],
      gitIgnoredCount: 0,
      earlyMessage: {
        kind: 'info',
        text: 'No matching code files among Git changed files.',
      },
    };
  }

  return { files, gitIgnoredCount: 0 };
}

function getHeaderTitle(scope: OrganizeScope, dryRun: boolean): string {
  const suffix = dryRun ? ' (dry-run)' : '';
  switch (scope.kind) {
    case 'folders':
      return `Organize imports in folder${suffix}`;
    case 'gitChanged':
      return `Organize imports on Git changed files${suffix}`;
    case 'workspace':
      return `Organize imports on all files${suffix}`;
  }
}

async function applyCollectedPreviewEdits(
  entries: readonly PreviewTextEditEntry[],
  options: {
    needsConfirmation: boolean;
    label: string;
    cleanDocUris: ReadonlySet<string>;
    saveAfterOrganize: boolean;
  }
): Promise<boolean> {
  const grouped = new Map<string, { uri: vscode.Uri; edits: vscode.TextEdit[] }>();
  for (const entry of entries) {
    const key = entry.uri.toString();
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = { uri: entry.uri, edits: [] };
      grouped.set(key, bucket);
    }
    bucket.edits.push(...entry.edits);
  }

  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const { uri, edits } of grouped.values()) {
    if (options.needsConfirmation) {
      const metadata: vscode.WorkspaceEditEntryMetadata = {
        needsConfirmation: true,
        label: options.label,
      };
      workspaceEdit.set(
        uri,
        edits.map((te): [vscode.TextEdit, vscode.WorkspaceEditEntryMetadata] => [
          te,
          metadata,
        ])
      );
    } else {
      workspaceEdit.set(uri, edits);
    }
  }

  const applied = await vscode.workspace.applyEdit(workspaceEdit);
  if (applied && options.saveAfterOrganize) {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty && options.cleanDocUris.has(doc.uri.toString())) {
        await doc.save();
      }
    }
  }

  return applied;
}

/**
 * Finds target workspace files and runs (or dry-runs) the configured import action.
 */
export async function runOrganizeImports(
  output: vscode.OutputChannel,
  runOptions: RunOrganizeOptions
): Promise<void> {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    void vscode.window.showWarningMessage('No workspace folder is open.');
    return;
  }

  const dryRun = runOptions.dryRun ?? false;
  const config = vscode.workspace.getConfiguration('organizeImportsAll');
  const configuredInclude = config.get<string>('include')?.trim();
  const includeGlob = configuredInclude || DEFAULT_INCLUDE_GLOB;
  const customExcludes = config.get<string[]>('exclude') ?? [...DEFAULT_EXCLUDE_PATTERNS];
  const ignoredFolders = config.get<string[]>('ignoredFolders') ?? [];
  const useWorkspaceExcludes = config.get<boolean>('useWorkspaceExcludes') ?? true;
  const useGitIgnore = config.get<boolean>('useGitIgnore') ?? true;
  const resolvedMode = resolveActionKindValue(config.get<string>('actionMode'));
  const targetKind =
    resolvedMode.mode === 'sortImports'
      ? vscode.CodeActionKind.Source.append('sortImports')
      : resolvedMode.mode === 'removeUnusedImports'
        ? vscode.CodeActionKind.Source.append('removeUnusedImports')
        : vscode.CodeActionKind.SourceOrganizeImports;
  const saveAfterOrganize = config.get<boolean>('saveAfterOrganize') ?? true;
  const showOutputOnRun = config.get<boolean>('showOutputOnRun') ?? true;

  const filesExclude = vscode.workspace
    .getConfiguration('files')
    .get<Record<string, unknown>>('exclude');
  const searchExclude = vscode.workspace
    .getConfiguration('search')
    .get<Record<string, unknown>>('exclude');

  const excludeGlob = buildExcludeGlob({
    customExcludes,
    ignoredFolders,
    filesExclude,
    searchExclude,
    useWorkspaceExcludes,
  });

  const progressTitle = getHeaderTitle(runOptions.scope, dryRun);

  interface RunSummary {
    cancelled: boolean;
    modifiedCount: number;
    processedCount: number;
    errorCount: number;
    previewEdits: PreviewTextEditEntry[];
    cleanDocUris: Set<string>;
    earlyMessage?: { kind: 'info' | 'warning'; text: string };
  }

  const summary = await vscode.window.withProgress<RunSummary>(
    {
      location: vscode.ProgressLocation.Notification,
      title: progressTitle,
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: 'Scanning workspace files...' });

      const discovered = await discoverTargetFiles(
        runOptions.scope,
        includeGlob,
        excludeGlob,
        useGitIgnore,
        token
      );

      if (token.isCancellationRequested) {
        return {
          cancelled: true,
          modifiedCount: 0,
          processedCount: 0,
          errorCount: 0,
          previewEdits: [],
          cleanDocUris: new Set(),
        };
      }

      if (discovered.earlyMessage) {
        return {
          cancelled: false,
          modifiedCount: 0,
          processedCount: 0,
          errorCount: 0,
          previewEdits: [],
          cleanDocUris: new Set(),
          earlyMessage: discovered.earlyMessage,
        };
      }

      const files = [...discovered.files].sort((a, b) => a.fsPath.localeCompare(b.fsPath));
      if (files.length === 0) {
        return {
          cancelled: false,
          modifiedCount: 0,
          processedCount: 0,
          errorCount: 0,
          previewEdits: [],
          cleanDocUris: new Set(),
          earlyMessage: {
            kind: 'info',
            text: 'No matching code files found.',
          },
        };
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
      if (ignoredFolders.length > 0) {
        output.appendLine(`Ignored folders: ${ignoredFolders.join(', ')}`);
      }
      if (discovered.gitIgnoredCount > 0) {
        output.appendLine(`Skipped by .gitignore: ${discovered.gitIgnoredCount} file(s)`);
      }
      output.appendLine(divider);

      const warmedLanguages = new Set<string>();
      const increment = 100 / files.length;
      const previewEdits: PreviewTextEditEntry[] = [];
      const cleanDocUris = new Set<string>();
      let modifiedCount = 0;
      let unsavedModifiedCount = 0;
      let unchangedCount = 0;
      let processedCount = 0;
      let errorCount = 0;

      for (let i = 0; i < files.length; i++) {
        if (token.isCancellationRequested) {
          break;
        }

        const uri = files[i];
        const relativePath = vscode.workspace.asRelativePath(uri, false);
        progress.report({
          message: `(${i + 1}/${files.length}) ${relativePath}`,
          increment,
        });

        try {
          const previewDoc = await vscode.workspace.openTextDocument(uri);
          const isFirstForLanguage = !warmedLanguages.has(previewDoc.languageId);
          warmedLanguages.add(previewDoc.languageId);

          const result = await organizeImportsInDocument(uri, {
            targetKind,
            isFirstForLanguage,
            saveAfterOrganize,
            dryRun,
            token,
          });
          processedCount++;

          if (result.modified) {
            modifiedCount++;
            if (dryRun) {
              previewEdits.push(...result.previewEdits);
              if (!result.wasDirty) {
                cleanDocUris.add(uri.toString());
              }
              output.appendLine(
                formatFileStatusLine({
                  index: i + 1,
                  total: files.length,
                  status: 'would-modify',
                  relativePath,
                })
              );
            } else {
              if (result.leftUnsaved) {
                unsavedModifiedCount++;
              }
              output.appendLine(
                formatFileStatusLine({
                  index: i + 1,
                  total: files.length,
                  status: 'modified',
                  relativePath,
                })
              );
            }
          } else {
            unchangedCount++;
            output.appendLine(
              formatFileStatusLine({
                index: i + 1,
                total: files.length,
                status: 'unchanged',
                relativePath,
              })
            );
          }
        } catch (err) {
          processedCount++;
          errorCount++;
          const msg = err instanceof Error ? err.message : String(err);
          output.appendLine(
            formatFileStatusLine({
              index: i + 1,
              total: files.length,
              status: 'error',
              relativePath,
              errorMessage: msg,
            })
          );
        }
      }

      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
      output.appendLine(divider);

      if (token.isCancellationRequested) {
        const verb = dryRun ? 'would be modified' : 'modified';
        output.appendLine(
          `⚠ Cancelled after ${elapsedSec}s — ${modifiedCount} ${verb}, ${unchangedCount} unchanged, ${errorCount} error(s) (${processedCount}/${files.length} processed)`
        );
        return {
          cancelled: true,
          modifiedCount,
          processedCount,
          errorCount,
          previewEdits,
          cleanDocUris,
        };
      }

      if (dryRun) {
        output.appendLine(
          `ℹ Dry run in ${elapsedSec}s — ${modifiedCount} would be modified, ${unchangedCount} unchanged, ${errorCount} error(s) (${processedCount}/${files.length} scanned)`
        );
      } else {
        output.appendLine(
          `✔ Completed in ${elapsedSec}s — ${modifiedCount} modified, ${unchangedCount} unchanged, ${errorCount} error(s) (${processedCount}/${files.length} processed)`
        );
        if (unsavedModifiedCount > 0) {
          output.appendLine(
            `ℹ Note: ${unsavedModifiedCount} modified file(s) remain unsaved in the editor (had prior unsaved changes or saveAfterOrganize is disabled).`
          );
        }
      }

      return {
        cancelled: false,
        modifiedCount,
        processedCount,
        errorCount,
        previewEdits,
        cleanDocUris,
      };
    }
  );

  if (summary.earlyMessage) {
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

  if (dryRun) {
    if (summary.modifiedCount === 0) {
      if (summary.errorCount > 0) {
        const pick = await vscode.window.showWarningMessage(
          `Dry run finished with ${summary.errorCount} error(s) and no changes.`,
          'Show Logs'
        );
        if (pick === 'Show Logs') {
          output.show(true);
        }
      } else {
        void vscode.window.showInformationMessage(
          'Dry run complete: all files already have organized imports.'
        );
      }
      return;
    }

    const selection = await vscode.window.showInformationMessage(
      `Dry run: ${summary.modifiedCount} of ${summary.processedCount} file(s) would be modified.`,
      'Open Refactor Preview',
      'Apply All'
    );

    if (selection === 'Open Refactor Preview') {
      const applied = await applyCollectedPreviewEdits(summary.previewEdits, {
        needsConfirmation: true,
        label: resolvedMode.label,
        cleanDocUris: summary.cleanDocUris,
        saveAfterOrganize,
      });
      if (applied) {
        output.appendLine(`✔ Applied changes to ${summary.modifiedCount} file(s).`);
      }
    } else if (selection === 'Apply All') {
      const applied = await applyCollectedPreviewEdits(summary.previewEdits, {
        needsConfirmation: false,
        label: resolvedMode.label,
        cleanDocUris: summary.cleanDocUris,
        saveAfterOrganize,
      });
      if (applied) {
        output.appendLine(`✔ Applied changes to ${summary.modifiedCount} file(s).`);
        void vscode.window.showInformationMessage(
          `Applied changes to ${summary.modifiedCount} file(s).`
        );
      }
    }
    return;
  }

  if (summary.errorCount > 0) {
    const selection = await vscode.window.showWarningMessage(
      `Organized imports in ${summary.modifiedCount} of ${summary.processedCount} file(s), with ${summary.errorCount} error(s).`,
      'Show Logs'
    );
    if (selection === 'Show Logs') {
      output.show(true);
    }
    return;
  }

  void vscode.window.showInformationMessage(
    `Organized imports in ${summary.modifiedCount} of ${summary.processedCount} file(s).`
  );
}
