import * as path from 'node:path';
import * as vscode from 'vscode';
import { ActionMode, resolveActionKindValue } from './glob';
import { OrganizeScope, RunOrganizeOptions, runOrganizeImports } from './organize';

const LAST_BASE_REF_STATE_KEY = 'organizeImportsAll.lastBranchBaseRef';

let isRunning = false;

interface ScopePickItem extends vscode.QuickPickItem {
  scopeKind: 'workspace' | 'gitChanged' | 'folders' | 'gitBranch' | 'files';
}

interface ActionModePickItem extends vscode.QuickPickItem {
  actionMode?: ActionMode;
}

const SCOPE_ITEMS: readonly ScopePickItem[] = [
  {
    label: 'All workspace files',
    description: 'Entire workspace',
    detail: 'All matching code files across open workspace folders.',
    scopeKind: 'workspace',
  },
  {
    label: 'Git changed files',
    description: 'Working tree',
    detail:
      'Staged, unstaged modified, and untracked non-ignored files in the current Git working tree.',
    scopeKind: 'gitChanged',
  },
  {
    label: 'Folder(s)...',
    description: 'Pick folders',
    detail: 'Choose one or more folders to scan.',
    scopeKind: 'folders',
  },
  {
    label: 'Git branch commits (vs base ref)...',
    description: 'Merge base..HEAD',
    detail:
      'Files changed by commits between merge base and HEAD (excludes working-tree-only files; analyzes current file contents).',
    scopeKind: 'gitBranch',
  },
  {
    label: 'Selected files...',
    description: 'Pick files',
    detail:
      'Choose specific files (filtered by workspace include, exclude, and .gitignore settings).',
    scopeKind: 'files',
  },
];

const ACTION_MODE_ITEMS: readonly ActionModePickItem[] = [
  {
    label: 'Organize Imports',
    description: 'source.organizeImports',
    detail: 'Sort imports and remove unused imports.',
    actionMode: 'organizeImports',
  },
  {
    label: 'Sort Imports',
    description: 'source.sortImports',
    detail: 'Sort and combine imports without removing unused imports (provider-dependent).',
    actionMode: 'sortImports',
  },
  {
    label: 'Remove Unused Imports',
    description: 'source.removeUnusedImports',
    detail: 'Remove unused imports without reordering (provider-dependent).',
    actionMode: 'removeUnusedImports',
  },
];

function getUriDedupKey(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? path.resolve(uri.fsPath) : uri.toString();
}

function collectExplorerUris(clickedUri?: vscode.Uri, selectedUris?: vscode.Uri[]): vscode.Uri[] {
  const raw = selectedUris?.length ? selectedUris : clickedUri ? [clickedUri] : [];
  return Array.from(new Map(raw.map((uri) => [getUriDedupKey(uri), uri])).values());
}

async function pickPaths(
  kind: 'files' | 'folders',
  openLabel: string
): Promise<vscode.Uri[] | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: kind === 'files',
    canSelectFolders: kind === 'folders',
    canSelectMany: true,
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    openLabel,
  });
  return picked?.length ? picked : undefined;
}

async function resolveExplorerSelectionScope(
  uris: readonly vscode.Uri[]
): Promise<OrganizeScope | undefined> {
  const entries = await Promise.all(
    uris.map(async (uri) => {
      try {
        return { uri, type: (await vscode.workspace.fs.stat(uri)).type };
      } catch {
        return undefined;
      }
    })
  );

  const folders: vscode.Uri[] = [];
  const files: vscode.Uri[] = [];
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    if ((entry.type & vscode.FileType.Directory) !== 0) {
      folders.push(entry.uri);
    } else if ((entry.type & vscode.FileType.File) !== 0) {
      files.push(entry.uri);
    }
  }

  if (folders.length === 0 && files.length === 0) {
    void vscode.window.showWarningMessage('No accessible files or folders were selected.');
    return undefined;
  }
  if (files.length === 0) {
    return { kind: 'folders', folders };
  }
  return { kind: 'files', files, folders };
}

async function promptForBaseRef(
  context: vscode.ExtensionContext,
  title: string
): Promise<string | undefined> {
  const rawInput = await vscode.window.showInputBox({
    title,
    prompt:
      'Enter an explicit Git base ref (for example, origin/main, main, tag, or commit SHA). Includes only files changed by commits between merge base and HEAD (excludes working-tree-only files) using current file contents.',
    placeHolder: 'origin/main',
    value: context.workspaceState.get<string>(LAST_BASE_REF_STATE_KEY, ''),
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return 'Enter a non-empty Git base ref.';
      }
      if (trimmed.startsWith('-')) {
        return 'Base ref cannot start with "-".';
      }
      if (/[\0\s]/.test(trimmed)) {
        return 'Base ref cannot contain whitespace.';
      }
      return undefined;
    },
  });

  const baseRef = rawInput?.trim();
  if (!baseRef) {
    return undefined;
  }

  await context.workspaceState.update(LAST_BASE_REF_STATE_KEY, baseRef);
  return baseRef;
}

async function pickScope(
  context: vscode.ExtensionContext,
  dryRun: boolean,
  title: string
): Promise<OrganizeScope | undefined> {
  const items = dryRun ? [...SCOPE_ITEMS.slice(1), SCOPE_ITEMS[0]] : SCOPE_ITEMS;
  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: dryRun
      ? 'Select scope to preview (dry-run)'
      : 'Select scope to organize imports',
    ignoreFocusOut: true,
  });
  if (!picked) {
    return undefined;
  }

  switch (picked.scopeKind) {
    case 'workspace':
      return { kind: 'workspace' };
    case 'gitChanged':
      return { kind: 'gitChanged' };
    case 'folders': {
      const folders = await pickPaths(
        'folders',
        dryRun ? 'Preview Imports in Folder' : 'Organize Imports in Folder'
      );
      return folders ? { kind: 'folders', folders } : undefined;
    }
    case 'files': {
      const files = await pickPaths(
        'files',
        dryRun ? 'Preview Imports on Files' : 'Organize Imports on Files'
      );
      return files ? { kind: 'files', files } : undefined;
    }
    case 'gitBranch': {
      const baseRef = await promptForBaseRef(context, title);
      return baseRef ? { kind: 'gitBranch', baseRef } : undefined;
    }
  }
}

async function pickActionMode(title: string): Promise<{ actionMode?: ActionMode } | undefined> {
  const configured = vscode.workspace
    .getConfiguration('organizeImportsAll')
    .get<string>('actionMode');
  const resolvedDefault = resolveActionKindValue(configured);

  const items: ActionModePickItem[] = [
    {
      label: `Configured default (${resolvedDefault.label})`,
      description: resolvedDefault.kindValue,
      detail: 'Use the current organizeImportsAll.actionMode setting for this run.',
    },
    ...ACTION_MODE_ITEMS,
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: 'Choose import action for this run (or press Enter for configured default)',
    ignoreFocusOut: true,
  });
  if (!picked) {
    return undefined;
  }

  return picked.actionMode ? { actionMode: picked.actionMode } : {};
}

function buildRunOptions(
  scope: OrganizeScope,
  dryRun: boolean,
  actionMode?: ActionMode
): RunOrganizeOptions {
  return actionMode !== undefined ? { scope, dryRun, actionMode } : { scope, dryRun };
}

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel(
    'Organize Imports on All Files',
    'organize-imports-output'
  );

  const canStart = (requireWorkspace: boolean): boolean => {
    if (isRunning) {
      void vscode.window.showInformationMessage('Organize imports on all files is already running.');
      return false;
    }
    if (requireWorkspace && !vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showWarningMessage('No workspace folder is open.');
      return false;
    }
    return true;
  };

  const runGuarded = async (fn: () => Promise<void>): Promise<void> => {
    if (!canStart(false)) {
      return;
    }
    isRunning = true;
    try {
      await fn();
    } finally {
      isRunning = false;
    }
  };

  const runScope = (scope: OrganizeScope, dryRun = false, actionMode?: ActionMode): Promise<void> =>
    runGuarded(() => runOrganizeImports(outputChannel, buildRunOptions(scope, dryRun, actionMode)));

  const runInteractive = async (
    title: string,
    dryRun: boolean,
    resolveScope: (title: string) => Promise<OrganizeScope | undefined>
  ): Promise<void> => {
    if (!canStart(true)) {
      return;
    }
    const scope = await resolveScope(title);
    if (!scope) {
      return;
    }
    const actionChoice = await pickActionMode(title);
    if (!actionChoice) {
      return;
    }
    await runScope(scope, dryRun, actionChoice.actionMode);
  };

  const runExplorer = async (
    clickedUri: vscode.Uri | undefined,
    selectedUris: vscode.Uri[] | undefined,
    options: {
      dryRun: boolean;
      promptTitle?: string;
      fallbackPicker?: { kind: 'files' | 'folders'; openLabel: string };
    }
  ): Promise<void> => {
    if (!canStart(true)) {
      return;
    }

    const explorerUris = collectExplorerUris(clickedUri, selectedUris);
    if (explorerUris.length === 0) {
      if (!options.fallbackPicker) {
        void vscode.window.showWarningMessage('No files or folders were selected.');
        return;
      }
      const picked = await pickPaths(options.fallbackPicker.kind, options.fallbackPicker.openLabel);
      if (!picked) {
        return;
      }
      const scope: OrganizeScope =
        options.fallbackPicker.kind === 'folders'
          ? { kind: 'folders', folders: picked }
          : { kind: 'files', files: picked };
      await runScope(scope, options.dryRun);
      return;
    }

    let actionMode: ActionMode | undefined;
    if (options.promptTitle) {
      const actionChoice = await pickActionMode(options.promptTitle);
      if (!actionChoice) {
        return;
      }
      actionMode = actionChoice.actionMode;
    }

    await runGuarded(async () => {
      const scope = await resolveExplorerSelectionScope(explorerUris);
      if (!scope) {
        return;
      }
      await runOrganizeImports(outputChannel, buildRunOptions(scope, options.dryRun, actionMode));
    });
  };

  context.subscriptions.push(
    outputChannel,
    vscode.commands.registerCommand('organizeImportsAll.run', () =>
      runScope({ kind: 'workspace' })
    ),
    vscode.commands.registerCommand('organizeImportsAll.dryRun', () =>
      runScope({ kind: 'workspace' }, true)
    ),
    vscode.commands.registerCommand('organizeImportsAll.runOnGitChanged', () =>
      runScope({ kind: 'gitChanged' })
    ),
    vscode.commands.registerCommand(
      'organizeImportsAll.runInFolder',
      (clickedUri?: vscode.Uri, selectedUris?: vscode.Uri[]) =>
        runExplorer(clickedUri, selectedUris, {
          dryRun: false,
          fallbackPicker: { kind: 'folders', openLabel: 'Organize Imports in Folder' },
        })
    ),
    vscode.commands.registerCommand(
      'organizeImportsAll.runOnFiles',
      (clickedUri?: vscode.Uri, selectedUris?: vscode.Uri[]) =>
        runExplorer(clickedUri, selectedUris, {
          dryRun: false,
          fallbackPicker: { kind: 'files', openLabel: 'Organize Imports on Selected Files' },
        })
    ),
    vscode.commands.registerCommand('organizeImportsAll.preview', () =>
      runInteractive('Organize Imports — Preview', true, (title) => pickScope(context, true, title))
    ),
    vscode.commands.registerCommand('organizeImportsAll.previewGitBranch', () =>
      runInteractive('Organize Imports — Git Branch Preview', true, async (title) => {
        const baseRef = await promptForBaseRef(context, title);
        return baseRef ? { kind: 'gitBranch', baseRef } : undefined;
      })
    ),
    vscode.commands.registerCommand('organizeImportsAll.runWithOptions', () =>
      runInteractive('Organize Imports — Run', false, (title) => pickScope(context, false, title))
    ),
    vscode.commands.registerCommand(
      'organizeImportsAll.previewSelection',
      (clickedUri?: vscode.Uri, selectedUris?: vscode.Uri[]) =>
        runExplorer(clickedUri, selectedUris, {
          dryRun: true,
          promptTitle: 'Organize Imports — Preview',
        })
    )
  );
}

export function deactivate(): void {}
