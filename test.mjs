import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'index.mjs'
)

/**
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 */
function run(args, options = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: options.cwd,
    timeout: 15_000,
  })
}

/**
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 */
function runAndFail(args, options = {}) {
  try {
    execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      cwd: options.cwd,
      timeout: 15_000,
    })
    assert.fail('Expected command to fail')
  } catch (error) {
    return /** @type {{ stderr: string, status: number }} */ (error)
  }
}

describe('repozip', () => {
  /** @type {string} */
  let fixtureDir

  before(async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), 'repozip-test-'))

    // Create a small fixture project
    await mkdir(path.join(fixtureDir, 'src'), { recursive: true })
    await mkdir(path.join(fixtureDir, 'node_modules', 'dep'), {
      recursive: true,
    })
    await mkdir(path.join(fixtureDir, 'docs'), { recursive: true })

    await writeFile(path.join(fixtureDir, 'package.json'), '{}')
    await writeFile(path.join(fixtureDir, 'src', 'index.js'), 'export {}')
    await writeFile(path.join(fixtureDir, 'docs', 'guide.md'), '# Guide')
    await writeFile(
      path.join(fixtureDir, 'node_modules', 'dep', 'index.js'),
      ''
    )
    await writeFile(path.join(fixtureDir, '.env'), 'SECRET=abc')
    await writeFile(path.join(fixtureDir, '.env.example'), 'SECRET=placeholder')
    await writeFile(path.join(fixtureDir, '.gitignore'), '*.ignoreme\n')
    await writeFile(path.join(fixtureDir, 'skip.ignoreme'), 'should be ignored')
  })

  after(async () => {
    await rm(fixtureDir, { recursive: true, force: true })
  })

  /** @param {string} dir */
  async function findZips(dir) {
    const entries = await readdir(dir)
    return entries.filter((name) => name.endsWith('.zip'))
  }

  /** @param {string} dir */
  async function cleanZips(dir) {
    for (const zip of await findZips(dir)) {
      await rm(path.join(dir, zip))
    }
  }

  test('--help prints usage and exits successfully', () => {
    const stdout = run(['--help'])
    assert.match(stdout, /Usage: repozip/)
    assert.match(stdout, /--exclude/)
    assert.match(stdout, /--output/)
  })

  test('unknown option exits with error', () => {
    const error = runAndFail(['--nope'])
    assert.equal(error.status, 1)
    assert.match(error.stderr, /Unknown option: --nope/)
  })

  test('--exclude without value exits with error', () => {
    const error = runAndFail(['--exclude'])
    assert.equal(error.status, 1)
    assert.match(error.stderr, /--exclude requires a comma-separated list/)
  })

  test('--output without value exits with error', () => {
    const error = runAndFail(['--output'])
    assert.equal(error.status, 1)
    assert.match(error.stderr, /--output requires a file path/)
  })

  test('extra positional argument exits with error', () => {
    const error = runAndFail(['/tmp', '/tmp2'])
    assert.equal(error.status, 1)
    assert.match(error.stderr, /Unexpected argument/)
  })

  test('creates a zip from a target directory', async () => {
    await cleanZips(fixtureDir)
    const stdout = run([fixtureDir])
    assert.match(stdout, /Found \d+ files/)
    assert.match(stdout, /Created /)

    const zips = await findZips(fixtureDir)
    assert.equal(zips.length, 1)
    // Verify simplified timestamp format: YYYYMMDD-HHmmss
    assert.match(zips[0], /\d{8}-\d{6}\.zip$/)

    await cleanZips(fixtureDir)
  })

  test('creates a zip from cwd when no target given', async () => {
    await cleanZips(fixtureDir)
    const stdout = run([], { cwd: fixtureDir })
    assert.match(stdout, /Created /)

    const zips = await findZips(fixtureDir)
    assert.equal(zips.length, 1)

    await cleanZips(fixtureDir)
  })

  test('excludes node_modules by default', async () => {
    await cleanZips(fixtureDir)
    const stdout = run([fixtureDir])

    // node_modules should not be counted in copied files
    // The fixture has: package.json, src/index.js, docs/guide.md, .env.example, .gitignore
    // Excluded: node_modules/**, .env, skip.ignoreme
    assert.match(stdout, /Found \d+ files/)

    const zips = await findZips(fixtureDir)
    assert.equal(zips.length, 1)

    // Verify zip contents do not include node_modules
    const zipPath = path.join(fixtureDir, zips[0])
    const listing = execFileSync('zipinfo', ['-1', zipPath], {
      encoding: 'utf8',
    })
    assert.ok(
      !listing.includes('node_modules'),
      'zip should not contain node_modules'
    )
    assert.ok(
      listing.includes('package.json'),
      'zip should contain package.json'
    )
    assert.ok(
      listing.includes('src/index.js'),
      'zip should contain src/index.js'
    )

    await cleanZips(fixtureDir)
  })

  test('respects .gitignore rules', async () => {
    await cleanZips(fixtureDir)
    run([fixtureDir])

    const zips = await findZips(fixtureDir)
    const zipPath = path.join(fixtureDir, zips[0])
    const listing = execFileSync('zipinfo', ['-1', zipPath], {
      encoding: 'utf8',
    })
    assert.ok(
      !listing.includes('skip.ignoreme'),
      'zip should respect .gitignore patterns'
    )

    await cleanZips(fixtureDir)
  })

  test('keeps .env.example while excluding .env', async () => {
    await cleanZips(fixtureDir)
    run([fixtureDir])

    const zips = await findZips(fixtureDir)
    const zipPath = path.join(fixtureDir, zips[0])
    const listing = execFileSync('zipinfo', ['-1', zipPath], {
      encoding: 'utf8',
    })

    const lines = listing.split('\n')
    const envFiles = lines.filter((l) => l.includes('.env'))
    assert.ok(
      envFiles.some((l) => l.endsWith('.env.example')),
      'zip should keep .env.example'
    )
    assert.ok(
      !envFiles.some((l) => l.endsWith('/.env') || l === '.env'),
      'zip should exclude .env'
    )

    await cleanZips(fixtureDir)
  })

  test('--exclude removes additional patterns', async () => {
    await cleanZips(fixtureDir)
    run([fixtureDir, '--exclude', 'docs'])

    const zips = await findZips(fixtureDir)
    const zipPath = path.join(fixtureDir, zips[0])
    const listing = execFileSync('zipinfo', ['-1', zipPath], {
      encoding: 'utf8',
    })
    assert.ok(
      !listing.includes('docs/'),
      'zip should exclude docs when passed via --exclude'
    )
    assert.ok(listing.includes('src/index.js'), 'zip should still include src')

    await cleanZips(fixtureDir)
  })

  test('--output writes zip to a custom path', async () => {
    const customPath = path.join(fixtureDir, 'custom-output.zip')
    try {
      const stdout = run([fixtureDir, '--output', customPath])
      assert.match(stdout, /Created /)

      const entries = await readdir(fixtureDir)
      assert.ok(entries.includes('custom-output.zip'))
    } finally {
      await rm(customPath, { force: true })
    }
  })
})
