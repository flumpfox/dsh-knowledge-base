/**
 * Find a Python interpreter the whole repository can use.
 *
 * The plugin runs the engine from the DSH skill, tests spawn it, and packaging does
 * not need it at all — so every script resolves Python the same way: an explicit
 * override first, then the runtime DSH ships, then whatever the platform provides.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Candidate commands, most specific first. */
export function pythonCandidates() {
  const home = process.env.USERPROFILE || homedir()
  const runtime = join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python')
  return [
    process.env.KB_PYTHON,
    join(runtime, 'python.exe'),
    join(runtime, 'bin', 'python3'),
    join(runtime, 'bin', 'python'),
    'python3',
    'python',
  ].filter(Boolean)
}

/**
 * The first candidate that exists (a path) or answers `--version` (a command).
 * Returns an empty string when nothing works, so callers can explain the requirement.
 */
export function findPython() {
  for (const candidate of pythonCandidates()) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate
      continue
    }
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore', windowsHide: true })
    if (!probe.error && probe.status === 0) return candidate
  }
  return ''
}
