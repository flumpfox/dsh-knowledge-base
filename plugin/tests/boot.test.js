/**
 * Boot check: the plugin must load from a checkout, where the Host's own
 * `@deepseek-ai/dsh-tools` is not on the module resolution path.
 *
 * A linked bundle that imports that package statically failed to start with
 * ERR_MODULE_NOT_FOUND, and the whole plugin (settings page included) never came
 * up after an application restart. These tests pin the degraded-but-alive
 * behaviour instead.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as plugin from '../index.js'

function fakeCtx(overrides = {}) {
  const cleanups = []
  const routes = []
  const tools = []
  const warnings = []
  const ctx = {
    get: name => (name === 'webServer'
      ? {
        register: route => {
          routes.push(route)
          return () => {}
        },
        getOrigin: () => 'http://127.0.0.1:1',
      }
      : overrides.services?.[name]),
    effect: fn => {
      const cleanup = fn()
      cleanups.push(cleanup)
      return cleanup
    },
    logger: { warn: message => warnings.push(String(message)) },
    tools: {
      register: definition => {
        tools.push(definition)
        return () => {}
      },
    },
  }
  return {
    ctx,
    routes,
    tools,
    warnings,
    dispose: () => cleanups.forEach(cleanup => typeof cleanup === 'function' && cleanup()),
  }
}

test('the module imports without the host tool package on the resolution path', () => {
  assert.equal(typeof plugin.apply, 'function')
  // `webServer` is declared so activation waits for the carrier: without it the
  // routes were never registered at startup and the page showed an error.
  assert.deepEqual(plugin.inject, ['tools', 'webServer'])
  assert.equal(plugin.name, 'knowledge-base-tools')
})

test('apply survives a missing tool builder and keeps the settings routes', async () => {
  const harness = fakeCtx()
  try {
    await plugin.apply(harness.ctx)
  } finally {
    harness.dispose()
  }
  // The settings page is registered before the tool builder is even looked up.
  assert.equal(harness.routes.length, 1)
  assert.equal(harness.routes[0].path, '/x-knowledge-base')
  if (harness.tools.length === 0) {
    // No builder here: the plugin says so instead of dying.
    assert.ok(harness.warnings.some(message => /dsh-tools/.test(message)),
      `expected a warning about the tool builder, got: ${harness.warnings.join(' | ')}`)
  } else {
    assert.deepEqual(harness.tools.map(tool => tool.name).sort(),
      ['kb_read', 'kb_review', 'kb_search', 'kb_status'])
  }
})
