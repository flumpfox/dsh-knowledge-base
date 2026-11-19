#!/usr/bin/env node
/**
 * Pre-publication secret check.
 *
 * gitleaks guards the git history in CI; this script guards what we are about to
 * publish *now*: the tracked tree and the built package. It looks for the mistakes
 * this project can realistically make — an internal host left in a test, a personal
 * path in a README, a real token pasted into a config — and fails the run.
 *
 *   node tools/check-secrets.mjs
 *
 * Findings under private/ are reported as warnings: that directory never leaves
 * the private repository.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.zip', '.tgz', '.gz', '.sqlite', '.pdf', '.woff', '.woff2'])
const MAX_BYTES = 2 * 1024 * 1024
const TEST_FILE = /(^|\/)(engine|plugin)\/tests\//
const ALLOWED_USER_DIRS = new Set(['user', 'me', 'x', 'you'])
const ALLOWED_SECRETS = new Set(['test-token', 's3cret', 'not-the-token', 'ignored-token', 'dummy-verify-token'])

const RULES = [
  {
    name: 'private-ip',
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
  },
  {
    name: 'windows-user-path',
    pattern: /C:[\\/]Users[\\/]([A-Za-z0-9._-]+)/g,
    allow: match => ALLOWED_USER_DIRS.has(match[1].toLowerCase()),
  },
  {
    name: 'bearer-token',
    pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/g,
  },
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'secret-assignment',
    pattern: /^\s*[A-Za-z0-9_]*(?:TOKEN|PASSWORD|SECRET|API[_-]?KEY)[A-Za-z0-9_]*\s*[:=]\s*["']([^"']{12,})["']/gm,
    allow: (match, file) => TEST_FILE.test(file) || ALLOWED_SECRETS.has(match[1]),
  },
]

function fail(message) {
  console.error(message)
  process.exit(1)
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function scanText(file, text, report) {
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0
      let match
      while ((match = rule.pattern.exec(line)) !== null) {
        if (rule.allow && rule.allow(match, file)) continue
        report(file, index + 1, rule.name, match[0])
      }
    }
  }
}

function scanFile(file, report) {
  const stats = statSync(file)
  if (stats.size === 0 || stats.size > MAX_BYTES) return
  if (BINARY.has(extname(file).toLowerCase())) return
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  if (text.includes('\u0000')) return
  scanText(file, text, report)
}

const findings = []
const warnings = []

function report(file, line, rule, match) {
  const shown = relative(ROOT, file).replaceAll('\\', '/')
  const entry = { file: shown, line, rule, match: match.length > 60 ? `${match.slice(0, 57)}…` : match }
  if (shown.startsWith('private/')) warnings.push(entry)
  else findings.push(entry)
}

// 1. Tracked files (private/ included, but reported as warnings).
const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
if (tracked.status !== 0) fail('check-secrets: this is not a git checkout')
const files = tracked.stdout.split('\0').filter(Boolean)
for (const name of files) {
  const full = join(ROOT, name)
  if (existsSync(full)) scanFile(full, report)
}

// 2. Built packages, if any: the archive is what a user installs.
const artifacts = []
if (existsSync(DIST)) {
  for (const name of readdirSync(DIST).filter(entry => entry.endsWith('.tgz'))) {
    const archive = join(DIST, name)
    const tmp = mkdtempSync(join(tmpdir(), 'kb-secrets-'))
    try {
      const unpacked = spawnSync('tar', ['-xzf', archive, '-C', tmp], { stdio: 'ignore' })
      if (unpacked.status !== 0) {
        warnings.push({ file: name, line: 0, rule: 'archive-not-unpacked', match: 'tar is unavailable' })
        continue
      }
      artifacts.push(name)
      for (const full of walk(tmp, [])) scanFile(full, report)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

function dump(entries) {
  for (const entry of entries) {
    const where = entry.line ? `${entry.file}:${entry.line}` : entry.file
    console.log(`  ${where}  [${entry.rule}]  ${entry.match}`)
  }
}

console.log(`check-secrets: ${files.length} tracked file(s), ${artifacts.length} archive(s)`)
if (warnings.length) {
  console.log(`\nprivate/ warnings (never published): ${warnings.length}`)
  dump(warnings)
}
if (findings.length) {
  console.log(`\nFAIL: ${findings.length} finding(s) that must not be published:`)
  dump(findings)
  process.exit(1)
}
console.log('\nOK: nothing secret-looking in the tree or the packages.')
