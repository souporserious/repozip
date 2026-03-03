#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  copyFile,
  readFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fastIgnore from 'fast-ignore'

const HELP_TEXT = `
Usage: repozip [target] [options]

Arguments:
  target           Path to the repo/directory to zip (default: current directory)

Options:
  --exclude <list> Comma-separated list of additional glob patterns to exclude
  --output         Output path for the zip file (default: <target>/<name>-<timestamp>.zip)
  --help           Show this help message

Examples:
  repozip
  repozip ../my-project
  repozip --exclude "docs,*.test.ts,fixtures"
  repozip ../my-project --output context.zip
`.trim()

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const args = argv.slice(2)
  let target = null
  /** @type {string[]} */
  let exclude = []
  /** @type {string | null} */
  let output = null

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    if (arg === '--help') {
      console.log(HELP_TEXT)
      process.exit(0)
    }

    if (arg === '--exclude') {
      const value = args[++index]
      if (!value) {
        console.error('Error: --exclude requires a comma-separated list')
        process.exit(1)
      }
      exclude = value
        .split(',')
        .map((/** @type {string} */ string) => string.trim())
        .filter(Boolean)
      continue
    }

    if (arg === '--output') {
      const value = args[++index]
      if (!value) {
        console.error('Error: --output requires a file path')
        process.exit(1)
      }
      output = value
      continue
    }

    if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}\n`)
      console.log(HELP_TEXT)
      process.exit(1)
    }

    if (!target) {
      target = arg
    } else {
      console.error(`Unexpected argument: ${arg}\n`)
      console.log(HELP_TEXT)
      process.exit(1)
    }
  }

  return { target, exclude, output }
}

const { target, exclude, output } = parseArgs(process.argv)

const sourceRoot = path.resolve(target || process.cwd())
const sourceRootPrefix = sourceRoot + path.sep
const repoName = path.basename(sourceRoot).replace(/[^\w.-]/g, '_')

const DEFAULT_IGNORE_FILE = `
# VCS
.git
.hg

# Build artifacts and caches
.next
.nuxt
.pnpm-store
.renoun
.svelte-kit
.turbo
.vscode
build
coverage
dist
node_modules
out
tmp

# System files
.DS_Store
Thumbs.db

# Environment files (keep examples)
.env
.env.*
!.env.example
!.env.*.example

# Lockfiles
bun.lock
bun.lockb
composer.lock
npm-shrinkwrap.json
package-lock.json
pnpm-lock.yaml
yarn.lock

# Common noisy outputs
*.log
*.tsbuildinfo
*.zip
`

const CONCURRENCY_LIMIT = 32

/**
 * @param {string} absolutePath
 * @returns {string}
 */
function toPosixRelativePath(absolutePath) {
  return absolutePath.slice(sourceRootPrefix.length).split(path.sep).join('/')
}

/**
 * @param {string} rootPath
 * @param {string[]} extraExcludes
 * @returns {Promise<(absolutePath: string) => boolean>}
 */
async function createIgnoreMatcher(rootPath, extraExcludes = []) {
  const ignoreFiles = [DEFAULT_IGNORE_FILE]
  const gitignorePath = path.join(rootPath, '.gitignore')

  try {
    ignoreFiles.push(await readFile(gitignorePath, 'utf8'))
    console.log(`Loaded ignore rules from ${gitignorePath}`)
  } catch (error) {
    const nodeError = /** @type {NodeJS.ErrnoException} */ (error)
    if (nodeError.code !== 'ENOENT') throw error
  }

  if (extraExcludes.length > 0) {
    ignoreFiles.push(extraExcludes.join('\n'))
    console.log(`Extra excludes: ${extraExcludes.join(', ')}`)
  }

  const ignore = fastIgnore(ignoreFiles)

  return (absolutePath) => {
    if (!absolutePath.startsWith(sourceRootPrefix)) return false
    return ignore(toPosixRelativePath(absolutePath))
  }
}

/**
 * @param {string} dirPath
 * @param {(absolutePath: string) => boolean} shouldIgnore
 * @param {string[]} collected
 * @returns {Promise<string[]>}
 */
async function collectFiles(dirPath, shouldIgnore, collected = []) {
  const entries = await readdir(dirPath, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue

    const absolutePath = path.join(dirPath, entry.name)

    if (entry.isDirectory()) {
      if (shouldIgnore(absolutePath)) continue
      await collectFiles(absolutePath, shouldIgnore, collected)
    } else if (entry.isFile()) {
      if (shouldIgnore(absolutePath)) continue
      collected.push(absolutePath)
    }
  }

  return collected
}

/**
 * @param {string} tempRoot
 * @param {string} repoName
 * @param {string} outputZipPath
 */
function createZip(tempRoot, repoName, outputZipPath) {
  try {
    if (process.platform === 'win32') {
      const stagedRepoPath = path.join(tempRoot, repoName)
      const psCommand = `Compress-Archive -Path "${stagedRepoPath}" -DestinationPath "${outputZipPath}"`
      const encoded = Buffer.from(psCommand, 'utf16le').toString('base64')
      execFileSync('powershell', ['-NoProfile', '-EncodedCommand', encoded], {
        stdio: 'inherit',
        shell: false,
      })
    } else {
      execFileSync('zip', ['-r', '-q', outputZipPath, repoName], {
        cwd: tempRoot,
        stdio: 'inherit',
        shell: false,
      })
    }
  } catch (error) {
    const nodeError = /** @type {NodeJS.ErrnoException} */ (error)
    if (nodeError.code === 'ENOENT') {
      const tool = process.platform === 'win32' ? 'powershell' : 'zip'
      console.error(`\`${tool}\` is required but was not found on PATH.`)
      process.exitCode = 1
    } else {
      throw error
    }
  }
}

/**
 * @param {Array<() => Promise<void>>} tasks
 * @param {number} limit
 */
async function runWithLimit(tasks, limit) {
  const executing = new Set()

  for (const task of tasks) {
    const promise = task().finally(() => executing.delete(promise))
    executing.add(promise)

    if (executing.size >= limit) {
      await Promise.race(executing)
    }
  }

  await Promise.all(executing)
}

const now = new Date()
const timestamp = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
  '-',
  String(now.getHours()).padStart(2, '0'),
  String(now.getMinutes()).padStart(2, '0'),
  String(now.getSeconds()).padStart(2, '0'),
].join('')
const outputZipPath = output
  ? path.resolve(output)
  : path.join(sourceRoot, `${repoName}-${timestamp}.zip`)
let tempRoot

try {
  tempRoot = await mkdtemp(path.join(tmpdir(), `${repoName}-`))
  const stagedRepoPath = path.join(tempRoot, repoName)

  console.log('Collecting files...')

  const shouldIgnore = await createIgnoreMatcher(sourceRoot, exclude)
  const files = await collectFiles(sourceRoot, shouldIgnore)

  console.log(
    `Copying ${files.length} files (concurrency: ${CONCURRENCY_LIMIT})...`
  )

  const tasks = files.map((absoluteSource) => async () => {
    if (!absoluteSource.startsWith(sourceRootPrefix)) return

    const relativePath = absoluteSource.slice(sourceRootPrefix.length)
    const absoluteDest = path.join(stagedRepoPath, relativePath)

    await mkdir(path.dirname(absoluteDest), { recursive: true })
    await copyFile(absoluteSource, absoluteDest)
  })

  await runWithLimit(tasks, CONCURRENCY_LIMIT)

  console.log(`Creating zip archive: ${outputZipPath}`)
  createZip(tempRoot, repoName, outputZipPath)

  if (process.exitCode !== 1) {
    console.log(`Archive created at ${outputZipPath}`)
  }
} finally {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
  }
}
