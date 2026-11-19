#!/usr/bin/env node
/**
 * Build the portable DSH bundle into dist/.
 *
 * Cross-platform replacement for the old PowerShell-only script: it finds pnpm (or
 * npm) the same way the rest of the repository finds tools, checks that the two
 * LICENSE copies have not drifted, and reports the archive it produced.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'plugin')
const DIST = join(ROOT, 'dist')

function fail(message) {
  console.error(message)
  process.exit(1)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

if (!existsSync(join(PLUGIN, 'package.json'))) fail('plugin/package.json is missing')

// The package is packed from plugin/, so the MIT text must also sit there.
const rootLicense = join(ROOT, 'LICENSE')
const packLicense = join(PLUGIN, 'LICENSE')
if (existsSync(rootLicense) && !existsSync(packLicense)) {
  fail('plugin/LICENSE is missing: copy LICENSE into plugin/ so the package carries it.')
}
if (existsSync(rootLicense) && existsSync(packLicense) && sha256(rootLicense) !== sha256(packLicense)) {
  fail('LICENSE and plugin/LICENSE differ: update both, then rebuild.')
}

mkdirSync(DIST, { recursive: true })

const home = process.env.USERPROFILE || homedir()
const pnpmMjs = join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
const shell = process.platform === 'win32'
let command
let args

if (process.env.PNPM) {
  command = process.execPath
  args = [process.env.PNPM, 'pack', '--pack-destination', DIST]
} else if (existsSync(pnpmMjs)) {
  command = process.execPath
  args = [pnpmMjs, 'pack', '--pack-destination', DIST]
} else {
  const probe = spawnSync('pnpm', ['--version'], { stdio: 'ignore', shell })
  if (!probe.error && probe.status === 0) {
    command = 'pnpm'
    args = ['pack', '--pack-destination', DIST]
  } else {
    command = 'npm'
    args = ['pack', '--pack-destination', DIST]
  }
}

const result = spawnSync(command, args, {
  cwd: PLUGIN,
  stdio: 'inherit',
  shell: command === 'pnpm' || command === 'npm' ? shell : false,
})
if (result.error) fail(`packaging failed: ${result.error.message}`)
if (result.status !== 0) process.exit(result.status ?? 1)

const newest = readdirSync(DIST)
  .filter(name => name.endsWith('.tgz'))
  .map(name => ({ name, mtime: statSync(join(DIST, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0]
if (!newest) fail('packaging produced no .tgz')

const size = (statSync(join(DIST, newest.name)).size / 1024).toFixed(0)
console.log(`Built ${join(DIST, newest.name)} (${size} KB)`)
