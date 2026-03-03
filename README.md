# repozip

A command-line tool to compress repositories into zip archives optimized for LLM
chatbots. It automatically respects `.gitignore` rules and excludes common noisy
files like `node_modules`, lockfiles, build artifacts, and environment files.

## Install

```sh
npm install -g repozip
```

## Usage

```sh
repozip [target] [options]
```

### Arguments

| Argument | Description                                      |
| -------- | ------------------------------------------------ |
| `target` | Path to the repo/directory to zip (default: `.`) |

### Options

| Option             | Description                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| `--exclude <list>` | Comma-separated list of additional glob patterns to exclude               |
| `--output`         | Output path for the zip file (default: `<target>/<name>-<timestamp>.zip`) |
| `--help`           | Show help message                                                         |

### Examples

Zip the current directory:

```sh
repozip
```

Zip a specific project:

```sh
repozip ../my-project
```

Exclude additional patterns:

```sh
repozip --exclude "docs,*.test.ts,fixtures"
```

Combine both:

```sh
repozip ../my-project --exclude "docs,*.test.ts"
```

Write to a specific output path:

```sh
repozip ../my-project --output context.zip
```

## How It Works

1. Collects all files in the target directory, skipping symlinks
2. Filters out files matching `.gitignore` rules and built-in defaults (build
   artifacts, lockfiles, caches, etc.)
3. Copies the remaining files to a temporary staging directory
4. Creates a timestamped zip archive in the target directory (e.g.
   `my-project-20260303-120000.zip`), or at the path specified by `--output`
5. Cleans up the temporary directory

## Default Excludes

The following are excluded by default in addition to `.gitignore` rules:

- **VCS** — `.git`, `.hg`
- **Build artifacts** — `.next`, `.nuxt`, `.turbo`, `build`, `dist`, `out`,
  `coverage`
- **Caches** — `.pnpm-store`, `.renoun`, `.svelte-kit`, `node_modules`, `tmp`
- **Editor/IDE** — `.vscode`
- **System files** — `.DS_Store`, `Thumbs.db`
- **Environment files** — `.env`, `.env.*` (except `.env.example`)
- **Lockfiles** — `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
  `bun.lock`, etc.
- **Misc** — `*.log`, `*.tsbuildinfo`, `*.zip`

## License

[MIT](/LICENSE.md) © [souporserious](https://souporserious.com/)
