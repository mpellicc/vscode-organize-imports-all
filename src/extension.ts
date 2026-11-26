import * as vscode from 'vscode';
import { runOrganizeImports } from './organize';

let isRunning = false;

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel(
    'Organize Imports on All Files',
    'organize-imports-output'
  );

  const runGuarded = async (fn: () => Promise<void>): Promise<void> => {
    if (isRunning) {
      void vscode.window.showInformationMessage(
        'Organize imports on all files is already running.'
      );
      return;
    }

    isRunning = true;
    try {
      await fn();
    } finally {
      isRunning = false;
    }
  };

  const runAll = vscode.commands.registerCommand('organizeImportsAll.run', () =>
    runGuarded(() => runOrganizeImports(outputChannel, { scope: { kind: 'workspace' } }))
  );

  const dryRun = vscode.commands.registerCommand('organizeImportsAll.dryRun', () =>
    runGuarded(() =>
      runOrganizeImports(outputChannel, { scope: { kind: 'workspace' }, dryRun: true })
    )
  );

  const runGitChanged = vscode.commands.registerCommand(
    'organizeImportsAll.runOnGitChanged',
    () => runGuarded(() => runOrganizeImports(outputChannel, { scope: { kind: 'gitChanged' } }))
  );

  const runInFolder = vscode.commands.registerCommand(
    'organizeImportsAll.runInFolder',
    async (clickedUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      if (isRunning) {
        void vscode.window.showInformationMessage(
          'Organize imports on all files is already running.'
        );
        return;
      }

      let folders =
        selectedUris && selectedUris.length > 0
          ? selectedUris
          : clickedUri
            ? [clickedUri]
            : undefined;

      if (!folders || folders.length === 0) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: true,
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
          openLabel: 'Organize Imports in Folder',
        });
        if (!picked || picked.length === 0) {
          return;
        }
        folders = picked;
      }

      const targetFolders = folders;
      await runGuarded(() =>
        runOrganizeImports(outputChannel, {
          scope: { kind: 'folders', folders: targetFolders },
        })
      );
    }
  );

  context.subscriptions.push(outputChannel, runAll, dryRun, runGitChanged, runInFolder);
}

export function deactivate(): void {}
