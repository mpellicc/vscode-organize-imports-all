# Organize Imports on All Files

[![Release](https://github.com/mpellicc/vscode-organize-imports-all/actions/workflows/release.yml/badge.svg)](https://github.com/mpellicc/vscode-organize-imports-all/actions/workflows/release.yml)
[![Visual Studio Marketplace](https://vsmarketplacebadges.dev/version-short/mpellicc.organize-imports-all.svg)](https://marketplace.visualstudio.com/items?itemName=mpellicc.organize-imports-all)

A VS Code extension by **[mpellicc](https://github.com/mpellicc)** that runs VS Code's `source.organizeImports` (or `source.sortImports` / `source.removeUnusedImports`) code action across your project with `.gitignore` support and colorized per-file status output.

Requires VS Code 1.80 or later. In VS Code 1.80, the built-in TypeScript and JavaScript provider supplies command-only import actions, so use a direct run for those files.

## Commands

Open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux):

- **`Organize imports on all files`** — Scans all matching code files in the workspace using your configured `actionMode`.
- **`Organize imports in folder`** — Right-click one or more folders in the Explorer sidebar (or pick folders via dialog from the Command Palette). Also handles mixed file + folder Explorer selections.
- **`Organize imports on selected files`** — Right-click one or more files (or a mixed file + folder selection) in the Explorer sidebar, or pick files via dialog from the Command Palette. Selected files still obey workspace `include`, `exclude`, `ignoredFolders`, `useWorkspaceExcludes`, and `useGitIgnore` filters.
- **`Organize imports on Git changed files`** — Runs only on staged, unstaged modified, and untracked (non-ignored) files in the current Git working tree.
- **`Organize imports on all files (dry-run)`** — Direct workspace dry-run shortcut. Scans without modifying or saving files, prints `~ WOULD MODIFY` lines, and lets you choose **`Open Refactor Preview`** (VS Code's native diff preview with per-file checkboxes) or **`Apply All`**.
- **`Organize imports: Preview (pick scope & action)`** — Interactive dry-run preview where you pick a scope (**Git changed files**, **Folder(s)**, **Git branch commits vs base ref**, **Selected files**, or **All workspace files**) and optionally override the import action for that run (**Configured default**, **Organize Imports**, **Sort Imports**, or **Remove Unused Imports**). You can also right-click files or folders in the Explorer sidebar and choose **`Organize imports (preview)`**.
- **`Organize imports on Git branch (preview)`** — Prompts for an explicit Git base ref (such as `origin/main`, `main`, a tag, or a commit SHA) and an optional per-run action, then previews files changed by commits between the merge base and `HEAD`.
- **`Organize imports: Run (pick scope & action)`** — Interactive direct run where you pick any scope (workspace, Git changed, folder(s), Git branch, or selected files) and choose the import action for a single run without editing your settings.

### Git Branch Scope Semantics

When running or previewing a **Git branch** scope:
- You are always prompted for an explicit base ref (no base branch is guessed silently).
- Only surviving files changed by commits between `git merge-base <baseRef> HEAD` and `HEAD` are included.
- Working-tree-only paths (uncommitted edits or untracked files that were not changed in commits since the merge base) are **not** included; use **Git changed files** for working-tree changes.
- Each matched file is analyzed using its **current** contents in the editor/workspace (not the historical commit snapshot).

## Preview & Save Behavior

- **Automatic saves and save participants (`saveAfterOrganize`)**: When `organizeImportsAll.saveAfterOrganize` is `true`, saving a modified file triggers VS Code's standard save lifecycle — including `editor.formatOnSave`, `editor.codeActionsOnSave`, and any other registered save participants. Those participants can apply additional formatting or edits beyond the import diff shown during dry-run preview. Files that already had unsaved edits before the run are left unsaved.
- **Command-only actions in dry-run preview**: Dry-run and Refactor Preview can only inspect and preview code actions that return explicit text edits (`WorkspaceEdit`). If a language provider returns a **command-only** action (a command with no inline text edits), the extension cannot predict or safely preview its effects; dry-run skips executing it and reports it separately in the Output panel as command-only / cannot be previewed. Use a non-dry-run command to execute command-only providers.
- **Per-run action support**: Choosing **Sort Imports** (`source.sortImports`) or **Remove Unused Imports** (`source.removeUnusedImports`) requires the active language extension to provide that code action kind (for example, VS Code's built-in TypeScript/JavaScript provider supports all three, while other languages may only implement `source.organizeImports`).
- **Competing language providers**: If multiple providers return matching import actions for a file, VS Code's preferred action (`isPreferred`) is chosen first, followed by the first effective matching action.

## Settings

Example `settings.json`:

```json
{
  "organizeImportsAll.actionMode": "organizeImports",
  "organizeImportsAll.useGitIgnore": true,
  "organizeImportsAll.ignoredFolders": [
    "generated",
    "src/legacy"
  ],
  "organizeImportsAll.showOutputOnRun": true,
  "organizeImportsAll.outputVerbosity": "all"
}
```

- `organizeImportsAll.actionMode`: Choose between `"organizeImports"` (`source.organizeImports`, default), `"sortImports"` (`source.sortImports`), or `"removeUnusedImports"` (`source.removeUnusedImports`).
- `organizeImportsAll.useGitIgnore`: Skip files matched by `.gitignore` when inside a Git repository (default: `true`).
- `organizeImportsAll.ignoredFolders`: Array of folder names (e.g. `"generated"`) or workspace-relative folder paths (e.g. `"src/legacy"`) to ignore on top of default excludes.
- `organizeImportsAll.showOutputOnRun`: Automatically open the **Organize Imports on All Files** Output panel when running the command (default: `true`).
- `organizeImportsAll.outputVerbosity`: Controls per-file logging in the Output panel — `"all"` (default, logs every scanned file) or `"changesOnly"` (logs only modified / would-modify files, command-only actions, save failures, and errors, while still showing run headers and summaries).
- `organizeImportsAll.include`: Glob pattern of files to scan (defaults to common code extensions such as `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.java`, `.rs`, etc.).
- `organizeImportsAll.exclude`: Array of glob patterns to exclude (`node_modules`, `.git`, `dist`, `build`, etc.).
- `organizeImportsAll.useWorkspaceExcludes`: Merge patterns set to `true` in `files.exclude` and `search.exclude` (default: `true`).
- `organizeImportsAll.saveAfterOrganize`: Automatically save previously clean files modified by the command (default: `true`). Note that saving triggers configured VS Code save participants such as `editor.formatOnSave` and `editor.codeActionsOnSave`.

## Development & Releases

```sh
nvm use
npm install
npm run compile
npm test
npm run package
```

Press **`F5`** in VS Code inside this project to launch an Extension Development Host window with the extension loaded.

Every push or merged PR to `main` automatically runs [`.github/workflows/release.yml`](.github/workflows/release.yml):
- Version bumps automatically from Conventional Commits (`feat:` → minor, `BREAKING CHANGE` / `!:` → major, other commits → patch).
- Creates a GitHub Release with the `.vsix` attached.
- Publishes to the Visual Studio Marketplace via OIDC Trusted Publishing (or `VSCE_PAT` repository secret if configured).
