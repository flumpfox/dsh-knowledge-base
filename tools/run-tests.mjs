#!/usr/bin/env node
/**
 * Run the repository test suites from any platform.
 *
 *   node tools/run-tests.mjs            both suites
 *   node tools/run-tests.mjs --engine   engine cases only
 *   node tools/run-tests.mjs --plugin   plugin tests only
 *
 * The engine is plain Python, the plugin tests spawn it, so Python is resolved once
 * and handed to the child through KB_PYTHON.
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findPython } from './lib/python.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const only = process.argv[2] || ''
const python = process.env.KB_PYTHON || findPython()

if (!python) {
  console.error('Python was not found. Set KB_PYTHON or install Python 3 (the DSH runtime ships one).')
  process.exit(1)
}

function run(label, command, args, env = {}) {
  console.log(`\n=== ${label} ===`)
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  if (result.error) {
    console.error(`${label}: ${result.error.message}`)
    return 1
  }
  return result.status ?? 1
}

let failed = 0

if (!only || only === '--engine') {
  failed += run('engine', python, [join(ROOT, 'engine', 'tests', 'run_tests.py')])
}

if (!only || only === '--plugin') {
  const tests = join(ROOT, 'plugin', 'tests')
  const files = readdirSync(tests)
    .filter(name => name.endsWith('.test.js'))
    .sort()
    .map(name => join(tests, name))
  failed += run('plugin', process.execPath, ['--test', ...files], { KB_PYTHON: python })
}

process.exit(failed === 0 ? 0 : 1)
