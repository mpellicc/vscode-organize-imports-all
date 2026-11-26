# Organize Imports on All Files

[![Release](https://github.com/mpellicc/vscode-organize-imports-all/actions/workflows/release.yml/badge.svg)](https://github.com/mpellicc/vscode-organize-imports-all/actions/workflows/release.yml)
[![Visual Studio Marketplace](https://vsmarketplacebadges.dev/version-short/mpellicc.organize-imports-all.svg)](https://marketplace.visualstudio.com/items?itemName=mpellicc.organize-imports-all)

A VS Code extension by **[mpellicc](https://github.com/mpellicc)** that runs VS Code's `source.organizeImports` (or `source.sortImports` / `source.removeUnusedImports`) code action across your project with `.gitignore` support and colorized per-file status output.

## Commands

Open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux):

- **`Organize imports on all files`** — Scans all matching code files in the workspace.
- **`Organize imports in folder`** — Right-click one or more folders in the Explorer sidebar (or pick folders via dialog from the Command Palette).
- **`Organize imports on Git changed files`** — Runs only on staged, unstaged modified, and untracked (non-ignored) files in the current Git working tree.
- **`Organize imports on all files (dry-run)`** — Scans without modifying or saving files, prints `~ WOULD MODIFY` lines, and lets you choose **`Open Refactor Preview`** (VS Code's native diff preview with per-file checkboxes) or **`Apply All`**.

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
  "organizeImportsAll.showOutputOnRun": true
}
```

- `organizeImportsAll.actionMode`: Choose between `"organizeImports"` (`source.organizeImports`, default), `"sortImports"` (`source.sortImports`), or `"removeUnusedImports"` (`source.removeUnusedImports`).
- `organizeImportsAll.useGitIgnore`: Skip files matched by `.gitignore` when inside a Git repository (default: `true`).
- `organizeImportsAll.ignoredFolders`: Array of folder names (e.g. `"generated"`) or workspace-relative folder paths (e.g. `"src/legacy"`) to ignore on top of default excludes.
- `organizeImportsAll.showOutputOnRun`: Automatically open the **Organize Imports on All Files** Output panel when running the command (default: `true`).
- `organizeImportsAll.include`: Glob pattern of files to scan (defaults to common code extensions such as `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.java`, `.rs`, etc.).
- `organizeImportsAll.exclude`: Array of glob patterns to exclude (`node_modules`, `.git`, `dist`, `build`, etc.).
- `organizeImportsAll.useWorkspaceExcludes`: Merge patterns set to `true` in `files.exclude` and `search.exclude` (default: `true`).
- `organizeImportsAll.saveAfterOrganize`: Automatically save previously clean files modified by the command (default: `true`).

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
