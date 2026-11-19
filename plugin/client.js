/**
 * Settings section for the Confluence knowledge bases.
 *
 * Plain ESM registered into the Settings navigation (`settings.section`) after
 * Plugins. One page edits every configured source: the source list on top, the
 * editor for the selected one, and the workspace sets below. All copy comes from
 * `locale/*.json`: this module registers those dictionaries with the locale
 * service and renders through the slot's `t`, so a language switch retranslates
 * the section without a reload.
 *
 * Every request goes to the Host half under /x-knowledge-base on the same
 * origin; tokens and passwords never travel back to the browser.
 */
window.__ModuleLoader__.load({
  id: '@flumpfox/dsh-knowledge-base',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'knowledge-base'
    const API = '/x-knowledge-base'
    const SOURCES = ['api', 'file']
    const AUTH_MODES = ['bearer', 'basic']
    const LANGUAGES = ['en', 'ru']
    const NOTICE_MS = 9000

    // ---------------------------------------------------------------------
    // host access
    // ---------------------------------------------------------------------

    class ApiError extends Error {
      constructor(code, params, detail, status) {
        super(code || 'error.internal')
        this.code = code || 'error.internal'
        this.params = params || {}
        this.detail = detail || ''
        this.status = status || 0
      }
    }

    async function call(path, options) {
      const response = await fetch(API + path, {
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        ...options,
      })
      let data = {}
      try {
        data = await response.json()
      } catch {
        /* a non-JSON answer is still a valid failure */
      }
      if (!response.ok || data.ok === false) {
        throw new ApiError(
          data.error || (response.ok ? 'error.internal' : 'error.connection'),
          data.params,
          data.params && data.params.detail,
          response.status,
        )
      }
      return data
    }

    /** Locale keys resolve to themselves when missing; fall back to a generic error. */
    function translateError(t, error) {
      const key = error && error.code ? error.code : 'error.internal'
      const text = t(key, (error && error.params) || {})
      return {
        text: text === key ? t('error.internal') : text,
        detail: (error && error.detail) || (error && error.params && error.params.detail) || '',
      }
    }

    function formatDateTime(value, locale) {
      const parsed = Date.parse(String(value || ''))
      if (Number.isNaN(parsed)) return String(value || '')
      try {
        return new Intl.DateTimeFormat(locale || 'en', { dateStyle: 'short', timeStyle: 'short' }).format(parsed)
      } catch {
        return new Date(parsed).toISOString().slice(0, 16).replace('T', ' ')
      }
    }

    function formatDuration(milliseconds, t) {
      const seconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000))
      if (!Number.isFinite(seconds)) return ''
      if (seconds < 60) return t('duration.seconds', { seconds })
      return t('duration.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
    }

    function formatBytes(bytes, t) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return ''
      if (value < 1024) return `${value} ${t('size.bytes')}`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} ${t('size.kb')}`
      return `${(value / (1024 * 1024)).toFixed(1)} ${t('size.mb')}`
    }

    // ---------------------------------------------------------------------
    // styles: host theme tokens only, no palette of our own
    // ---------------------------------------------------------------------

    const CSS = `
.ckb { display: flex; flex-direction: column; gap: 26px; max-width: 760px; color: var(--dsw-alias-label-primary); }
.ckb h2 { margin: 0; font-size: 18px; font-weight: 600; line-height: 26px; }
.ckb-intro { margin: 6px 0 0; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.ckb-block { display: flex; flex-direction: column; gap: 10px; }
.ckb-block + .ckb-block { border-top: 0.5px solid var(--dsw-alias-border-l1); padding-top: 22px; }
.ckb-title { margin: 0; font-size: 14px; font-weight: 500; line-height: 20px; }
.ckb-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.ckb-panel { display: flex; flex-direction: column; padding: 0 16px; border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2)); border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1)); }
.ckb-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.ckb-panel > .ckb-field + .ckb-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.ckb-label { font-size: 13px; font-weight: 500; line-height: 1.5; }
.ckb-input { width: 100%; box-sizing: border-box; height: 34px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1)); font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.ckb-input:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; border-color: var(--dsw-alias-state-business-primary); }
.ckb-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.ckb-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ckb-grow { flex: 1 1 220px; min-width: 0; }
.ckb-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; padding: 0 14px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1)); font: inherit; font-size: 13px; font-weight: 500; line-height: 1; color: var(--dsw-alias-label-primary); cursor: pointer; white-space: nowrap; }
.ckb-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
@media (hover: hover) { .ckb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); } }
.ckb-btn:disabled { opacity: 0.5; cursor: default; }
.ckb-btn[data-kind="primary"] { border-color: transparent; background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); color: var(--dsw-alias-label-on-color, #fff); }
@media (hover: hover) { .ckb-btn[data-kind="primary"]:hover:not(:disabled) { background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); opacity: 0.9; } }
.ckb-btn[data-kind="quiet"] { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.ckb-btn[data-kind="danger"] { border-color: transparent; background: var(--dsw-alias-state-error-primary, #c0392b); color: var(--dsw-alias-label-on-color, #fff); }
@media (hover: hover) { .ckb-btn[data-kind="danger"]:hover:not(:disabled) { opacity: 0.9; } }
.ckb-danger { color: var(--dsw-alias-state-error-primary, #c0392b); }
.ckb-dialog { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); }
.ckb-dialog h4 { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.5; }
.ckb-export-result { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); }
.ckb-export-result > span { flex: 1 1 240px; min-width: 0; }
.ckb-choices { display: flex; flex-wrap: wrap; gap: 18px; margin: 0; padding: 0; border: 0; }
.ckb-choice { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; line-height: 20px; }
.ckb-choice input { margin: 0; accent-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.ckb-list { display: flex; flex-direction: column; gap: 2px; max-height: 260px; overflow-y: auto; margin: 0; padding: 6px 10px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-layer-1); }
.ckb-item { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; font-size: 13px; line-height: 20px; cursor: pointer; }
.ckb-item input { margin: 0 0 0 1px; accent-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.ckb-key { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ckb-name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.ckb-count { flex: none; font-size: 12px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ckb-bar { position: relative; height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.ckb-bar > span { display: block; height: 100%; border-radius: 3px; background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); transition: width 240ms ease-out; }
.ckb-bar[data-unknown="true"] > span { width: 30% !important; opacity: 0.45; }
.ckb-progress-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; font-size: 13px; }
.ckb-progress-num { font-variant-numeric: tabular-nums; font-weight: 500; }
.ckb-status { display: flex; flex-direction: column; gap: 4px; font-size: 12px; line-height: 1.5; }
.ckb-status[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.ckb-status[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.ckb-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.ckb-status[data-tone="idle"] { color: var(--dsw-alias-label-tertiary); }
.ckb-detail { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.ckb-log { margin: 0; border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-layer-2); }
.ckb-log > summary { padding: 8px 12px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.ckb-log > summary:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; border-radius: var(--dsw-radius-md, 12px); }
.ckb-log-body { padding: 0 12px 10px; }
.ckb-log-text { margin: 6px 0 0; max-height: 220px; overflow: auto; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); }
.ckb-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.ckb-inline { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
.ckb-num { width: 96px; }
.ckb-badge { flex: none; padding: 0 6px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2); font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.ckb-ws { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; padding: 8px 0; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.ckb-ws-path { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.ckb-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 640px) { .ckb-num { width: 100%; } .ckb-item { flex-wrap: wrap; } }
`

    // ---------------------------------------------------------------------
    // small building blocks
    // ---------------------------------------------------------------------

    function Field({ id, label, hint, children }) {
      return h('div', { className: 'ckb-field' },
        h('label', { className: 'ckb-label', htmlFor: id }, label),
        children,
        hint ? h('p', { className: 'ckb-hint', id: `${id}-hint` }, hint) : null)
    }

    function Bar({ progress, label }) {
      const unknown = progress.percent === null
      return h('div', {
        className: 'ckb-bar',
        role: 'progressbar',
        'aria-label': label,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        ...(unknown ? {} : { 'aria-valuenow': progress.percent }),
        'aria-valuetext': unknown ? `${progress.done}` : `${progress.percent}%`,
        'data-unknown': unknown ? 'true' : 'false',
      }, h('span', { style: { width: `${unknown ? 30 : progress.percent}%` } }))
    }

    /** The space list in its own memo boundary: the clock tick must not redraw 300 rows. */
    const SpaceList = React.memo(function SpaceList({
      rows, selected, running, disabled, label, onToggle, t,
    }) {
      const chosen = React.useMemo(() => new Set(selected), [selected])
      return h('div', { className: 'ckb-list', role: 'group', 'aria-label': label },
        rows.map(space => h('label', { key: space.key, className: 'ckb-item' },
          h('input', {
            type: 'checkbox',
            checked: chosen.has(space.key),
            disabled: running || disabled,
            onChange: () => onToggle(space.key),
          }),
          h('span', { className: 'ckb-key', title: space.key }, space.key),
          h('span', { className: 'ckb-name' }, space.name || space.key),
          space.pages ? h('span', { className: 'ckb-count' }, t('spaces.pages', { count: space.pages })) : null)))
    })

    // ---------------------------------------------------------------------
    // the section
    // ---------------------------------------------------------------------

    function Section(props) {
      const t = props.t || ((key, params) => {
        const dict = fallbackDictionary || {}
        const template = dict[key] || key
        return params
          ? String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
          : template
      })

      // registry
      const [list, setList] = React.useState([])
      const [defaultId, setDefaultId] = React.useState('')
      const [workspaces, setWorkspaces] = React.useState([])
      const [selectedId, setSelectedId] = React.useState('')
      // selected source
      const [state, setState] = React.useState(null)
      const [name, setName] = React.useState('')
      const [source, setSource] = React.useState('api')
      const [auth, setAuth] = React.useState('bearer')
      const [baseUrl, setBaseUrl] = React.useState('')
      const [filePath, setFilePath] = React.useState('')
      const [token, setToken] = React.useState('')
      const [user, setUser] = React.useState('')
      const [password, setPassword] = React.useState('')
      const [spaces, setSpaces] = React.useState([])
      const [selected, setSelected] = React.useState([])
      const [spacesAll, setSpacesAll] = React.useState(false)
      const [filter, setFilter] = React.useState('')
      const [incrementalDays, setIncrementalDays] = React.useState(7)
      const [fullDays, setFullDays] = React.useState(30)
      const [job, setJob] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const [announce, setAnnounce] = React.useState('')
      const [clock, setClock] = React.useState(() => Date.now())
      const [loaded, setLoaded] = React.useState(false)
      const [loadError, setLoadError] = React.useState(null)
      const [failures, setFailures] = React.useState(0)
      const [importPath, setImportPath] = React.useState('')
      const [confirmAction, setConfirmAction] = React.useState('')
      const [exportOpen, setExportOpen] = React.useState(false)
      const [exportDir, setExportDir] = React.useState('')
      const [exportName, setExportName] = React.useState('')
      const [exportJob, setExportJob] = React.useState(null)
      const [exportConflict, setExportConflict] = React.useState(null)
      const [picking, setPicking] = React.useState(false)
      const [createOpen, setCreateOpen] = React.useState(false)
      const [newName, setNewName] = React.useState('')
      const [newId, setNewId] = React.useState('')
      const importRef = React.useRef(null)
      const stopRef = React.useRef(null)

      const running = Boolean(job && job.state === 'running')
      const locale = currentLocale()
      const ids = {
        baseUrl: React.useId(), token: React.useId(), filePath: React.useId(),
        filter: React.useId(), incremental: React.useId(), full: React.useId(),
        source: React.useId(), title: React.useId(), auth: React.useId(),
        user: React.useId(), password: React.useId(), name: React.useId(),
        pick: React.useId(), importPath: React.useId(),
        exportTitle: React.useId(), exportDir: React.useId(), exportName: React.useId(),
        createTitle: React.useId(), createName: React.useId(), createId: React.useId(),
        exportConflictTitle: React.useId(),
      }
      const selectedSource = list.find(row => row.id === selectedId)
      const sourcePath = `/sources/${encodeURIComponent(selectedId)}`

      const applySource = React.useCallback(data => {
        setState(data)
        setName(data.name || '')
        setSource(SOURCES.includes(data.source) ? data.source : 'api')
        setAuth(AUTH_MODES.includes(data.auth) ? data.auth : 'bearer')
        setBaseUrl(data.baseUrl || '')
        setFilePath(data.filePath || '')
        setUser(data.basicUser || '')
        setPassword('')
        setToken('')
        setSelected(Array.isArray(data.spaces) ? data.spaces : [])
        setSpacesAll(Boolean(data.spacesAll))
        setIncrementalDays(data.schedule?.incrementalDays ?? 7)
        setFullDays(data.schedule?.fullDays ?? 30)
        if (data.job) setJob(data.job)
      }, [])

      const loadList = React.useCallback(async () => {
        const data = await call('/sources')
        setList(data.sources || [])
        setDefaultId(data.defaultId || '')
        setWorkspaces(data.workspaces || [])
        return data
      }, [])

      /** Suggested export path and the last export job of the selected source. */
      const loadExportInfo = React.useCallback(async (id) => {
        if (!id) {
          setExportOpen(false)
          setExportJob(null)
          return
        }
        try {
          const data = await call(`/sources/${encodeURIComponent(id)}/export`)
          setExportDir(data.directory || '')
          setExportName(data.fileName || '')
          setExportJob(data.job && data.job.state !== 'idle' ? data.job : null)
        } catch {
          /* the export panel simply starts empty; the dialog still asks */
        }
      }, [])

      const loadSource = React.useCallback(async (id) => {
        if (!id) return
        applySource(await call(`/sources/${encodeURIComponent(id)}/state`))
        setExportOpen(false)
        await loadExportInfo(id)
      }, [applySource, loadExportInfo])

      const boot = React.useCallback(async () => {
        try {
          const data = await loadList()
          const first = data.sources.find(row => row.id === data.defaultId) || data.sources[0]
          if (first) {
            setSelectedId(first.id)
            await loadSource(first.id)
          }
          setLoadError(null)
        } catch (error) {
          setLoadError(translateError(t, error))
          setFailures(count => count + 1)
        } finally {
          setLoaded(true)
        }
      }, [loadList, loadSource, t])

      React.useEffect(() => { void boot() }, [boot])

      // The Host half may still be starting (or being reinstalled) when this
      // page mounts. While the registry cannot be read, keep asking with
      // backoff instead of leaving a dead error panel.
      React.useEffect(() => {
        if (!loadError || failures === 0 || failures > 12) return undefined
        const timer = setTimeout(() => { void boot() }, 5000)
        return () => clearTimeout(timer)
      }, [loadError, failures, boot])

      // A notice belongs to the action that produced it; leave it long enough to
      // read, then let the next status take over.
      React.useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(null), NOTICE_MS)
        return () => clearTimeout(timer)
      }, [notice])

      // Poll the selected source's job while an import runs.
      React.useEffect(() => {
        if (!running || !selectedId) return undefined
        const timer = setInterval(async () => {
          setClock(Date.now())
          try {
            setJob(await call(`${sourcePath}/job`))
          } catch {
            /* a transient poll failure is not worth a banner */
          }
        }, 900)
        return () => clearInterval(timer)
      }, [running, selectedId, sourcePath])

      // Poll the export job while the archive is being packed.
      React.useEffect(() => {
        if (exportJob?.state !== 'running' || !selectedId) return undefined
        const timer = setInterval(async () => {
          try {
            setExportJob(await call(`${sourcePath}/export/job`))
          } catch {
            /* a transient poll failure is not worth a banner */
          }
        }, 700)
        return () => clearInterval(timer)
      }, [exportJob?.state, selectedId, sourcePath])

      // Announce the outcome once: the panel keeps the path visible anyway.
      React.useEffect(() => {
        if (!exportJob) return
        if (exportJob.state === 'done') {
          setAnnounce(t('base.exported', {
            path: exportJob.path,
            count: exportJob.articles ?? 0,
            size: formatBytes(exportJob.bytes ?? 0, t) || '',
          }))
        } else if (exportJob.state === 'cancelled') {
          setAnnounce(t('base.exportCancelled'))
        }
      }, [exportJob?.state])

      // Moving between Import and Stop replaces the focused node; hand focus to
      // the counterpart so the keyboard user never lands on <body>.
      React.useEffect(() => {
        if (!job) return
        const active = document.activeElement
        if (job.state === 'running') {
          if (active === importRef.current) stopRef.current?.focus()
        } else if (active === stopRef.current) {
          importRef.current?.focus()
        }
      }, [job?.state])

      const run = async (action, task) => {
        setBusy(action)
        setNotice(null)
        try {
          await task()
        } catch (error) {
          setNotice({ tone: 'error', ...translateError(t, error) })
        } finally {
          setBusy('')
        }
      }

      const payload = () => ({
        name,
        source,
        auth,
        baseUrl,
        filePath,
        spaces: selected,
        spacesAll,
        incrementalDays,
        fullDays,
        locale,
      })

      const saveSettings = () => run('save', async () => {
        const data = await call(sourcePath, { method: 'POST', body: JSON.stringify(payload()) })
        applySource(data.source)
        await loadList()
        setNotice({ tone: 'ok', text: t('notice.saved') })
      })

      const saveCredential = () => run('credential', async () => {
        const answer = auth === 'bearer'
          ? await call(`${sourcePath}/token`, { method: 'POST', body: JSON.stringify({ token }) })
          : await call(`${sourcePath}/basic`, { method: 'POST', body: JSON.stringify({ user, password }) })
        setToken('')
        setPassword('')
        await loadSource(selectedId)
        setNotice({
          tone: 'ok',
          text: auth === 'bearer'
            ? t('token.saved')
            : t('status.basicSaved', { user: answer.basicUser || user }),
        })
      })

      const deleteCredential = () => run('credential', async () => {
        await call(`${sourcePath}/${auth === 'bearer' ? 'token' : 'basic'}`, {
          method: 'POST',
          body: JSON.stringify(auth === 'bearer' ? { token: '' } : { user: '', password: '' }),
        })
        setToken('')
        setPassword('')
        await loadSource(selectedId)
        setNotice({
          tone: 'ok',
          text: auth === 'bearer' ? t('token.deleted') : t('status.basicDeleted'),
        })
      })

      const checkSource = () => run('check', async () => {
        const data = await call(`${sourcePath}/test`, {
          method: 'POST',
          body: JSON.stringify(source === 'api'
            ? { source, auth, baseUrl, token, user, password }
            : { source, filePath }),
        })
        setSpaces(data.spaces || [])
        setNotice({
          tone: 'ok',
          text: source === 'api'
            ? (data.identity?.username
              ? t('test.connectionOkAs', { user: data.identity.username, count: (data.spaces || []).length })
              : t('test.connectionOk', { count: (data.spaces || []).length }))
            : ((data.spaces || []).length
              ? t('test.fileOk', {
                pages: data.pages, spaces: (data.spaces || []).length, size: formatBytes(data.bytes, t) || '—',
              })
              : t('test.fileOkNoSpaces', { pages: data.pages, size: formatBytes(data.bytes, t) || '—' })),
        })
      })

      const startImport = full => run('import', async () => {
        // Import what is on screen: the Host reads its saved profile, so the form
        // is committed first.
        await call(sourcePath, { method: 'POST', body: JSON.stringify(payload()) })
        const data = await call(`${sourcePath}/import`, {
          method: 'POST',
          body: JSON.stringify({ full, locale }),
        })
        setJob(data.job)
        setClock(Date.now())
      })

      const stopImport = () => run('stop', async () => {
        const data = await call(`${sourcePath}/cancel`, { method: 'POST', body: JSON.stringify({}) })
        setJob(data.job)
      })

      const openCreate = () => {
        setCreateOpen(true)
        setNewName('')
        setNewId('')
        setNotice(null)
      }

      const createSource = () => run('registry', async () => {
        const id = newId.trim().toLowerCase()
        if (!/^[a-z][a-z0-9-]*$/.test(id)) {
          setNotice({ tone: 'error', text: t('sources.badId') })
          return
        }
        const data = await call('/sources', {
          method: 'POST',
          body: JSON.stringify({ id, name: newName.trim() || id }),
        })
        setCreateOpen(false)
        const fresh = await loadList()
        setSelectedId(data.id)
        await loadSource(data.id)
        setNotice({
          tone: 'ok',
          text: t('sources.created', { name: fresh.sources.find(row => row.id === data.id)?.name || data.id }),
        })
      })

      const deleteSource = () => run('registry', async () => {
        await call(`${sourcePath}/delete`, { method: 'POST', body: JSON.stringify({}) })
        setConfirmAction('')
        const fresh = await loadList()
        const next = fresh.sources.find(row => row.id === fresh.defaultId) || fresh.sources[0]
        setSelectedId(next ? next.id : '')
        if (next) await loadSource(next.id)
        else setState(null)
        setNotice({ tone: 'ok', text: t('sources.deleted', { name: name || selectedId }) })
      })

      const clearBase = () => run('clear', async () => {
        const data = await call(`${sourcePath}/clear`, { method: 'POST', body: JSON.stringify({}) })
        setConfirmAction('')
        applySource(data.source)
        await loadList()
        setNotice({ tone: 'ok', text: t('notice.cleared') })
      })

      const openExport = () => run('exportPlan', async () => {
        const data = await call(`${sourcePath}/export`)
        setExportDir(data.directory || '')
        setExportName(data.fileName || '')
        if (data.job && data.job.state !== 'idle') setExportJob(data.job)
        setConfirmAction('')
        setExportConflict(null)
        setExportOpen(true)
      })

      const pickExportDir = () => run('pickFolder', async () => {
        setPicking(true)
        try {
          const data = await call('/pick-folder', { method: 'POST', body: JSON.stringify({}) })
          if (data.path) {
            setExportDir(data.path)
            setExportConflict(null)
          }
        } finally {
          setPicking(false)
        }
      })

      const startExportAction = (overwrite = false) => run('export', async () => {
        try {
          const data = await call(`${sourcePath}/export`, {
            method: 'POST',
            body: JSON.stringify({ directory: exportDir, fileName: exportName, overwrite }),
          })
          setExportJob(data.job)
          setExportOpen(false)
          setExportConflict(null)
        } catch (error) {
          // The target exists: ask before replacing it instead of failing.
          if (error?.code === 'error.exportExists') {
            setExportConflict({ fileName: exportName })
            return
          }
          throw error
        }
      })

      const confirmOverwrite = () => startExportAction(true)

      const cancelExportAction = () => run('exportCancel', async () => {
        const data = await call(`${sourcePath}/export/cancel`, {
          method: 'POST',
          body: JSON.stringify({}),
        })
        setExportJob(data.job)
      })

      const revealExport = () => run('reveal', async () => {
        await call(`${sourcePath}/export/reveal`, { method: 'POST', body: JSON.stringify({}) })
      })

      const importBaseArchive = () => run('importBase', async () => {
        const data = await call('/import-base', {
          method: 'POST',
          body: JSON.stringify({ filePath: importPath }),
        })
        setImportPath('')
        await loadList()
        setSelectedId(data.id)
        await loadSource(data.id)
        setNotice({
          tone: 'ok',
          text: t('notice.imported', { name: data.name || data.id, count: data.articles ?? 0 }),
        })
      })

      const makeDefault = () => run('registry', async () => {
        await call('/default', { method: 'POST', body: JSON.stringify({ id: selectedId }) })
        const fresh = await loadList()
        setDefaultId(fresh.defaultId)
        setNotice({ tone: 'ok', text: t('sources.defaultSet', { name }) })
      })

      const toggleWorkspaceSource = (workspaceId, sourceId, checked) => run('workspaces', async () => {
        const workspace = workspaces.find(row => row.id === workspaceId)
        const current = workspace?.sources || []
        const next = checked
          ? [...new Set([...current, sourceId])]
          : current.filter(id => id !== sourceId)
        const data = await call('/workspaces', {
          method: 'POST',
          body: JSON.stringify({ workspaceId, sources: next }),
        })
        setWorkspaces(data.workspaces || [])
        setNotice({ tone: 'ok', text: t('workspace.saved') })
      })

      const selectSource = id => {
        setSelectedId(id)
        setNotice(null)
        setConfirmAction('')
        void run('select', () => loadSource(id))
      }

      const toggleSpace = React.useCallback((key) => {
        setSelected(current => (current.includes(key)
          ? current.filter(item => item !== key)
          : [...current, key]))
      }, [])

      const filtered = React.useMemo(() => {
        const needle = filter.trim().toLowerCase()
        if (!needle) return spaces
        return spaces.filter(space =>
          String(space.key || '').toLowerCase().includes(needle)
          || String(space.name || '').toLowerCase().includes(needle))
      }, [spaces, filter])

      const selectAllFiltered = () => {
        const keys = filtered.map(space => space.key)
        const next = [...new Set([...selected, ...keys])]
        setSelected(next)
        setAnnounce(t('spaces.selected', { selected: next.length, total: spaces.length }))
      }

      const clearSelection = () => {
        setSelected([])
        setAnnounce(t('spaces.selectedOnly', { selected: 0 }))
      }

      if (!loaded) {
        return h('div', { className: 'ckb' },
          h('p', { className: 'ckb-hint' }, t('section.loading')))
      }
      /** Path + button for importing a portable base archive. */
      const importRow = extra => h('div', { className: 'ckb-row' },
        h('label', { className: 'ckb-sr', htmlFor: ids.importPath }, t('sources.importPath')),
        h('input', {
          id: ids.importPath, className: 'ckb-input ckb-grow', type: 'text', value: importPath,
          placeholder: t('sources.importPathPlaceholder'), autoComplete: 'off', spellCheck: false,
          disabled: Boolean(busy),
          onChange: event => setImportPath(event.target.value),
        }),
        h('button', {
          type: 'button', className: 'ckb-btn', ...extra,
          disabled: Boolean(busy) || !importPath.trim(), onClick: importBaseArchive,
        }, t('sources.importButton')))

      /** Name + id form: the id decides the folder, the routes and the credential slot. */
      const createDialog = () => (createOpen ? h('div', {
        className: 'ckb-dialog', role: 'dialog', 'aria-modal': 'false',
        'aria-labelledby': ids.createTitle,
        onKeyDown: event => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            setCreateOpen(false)
          }
        },
      },
      h('h4', { id: ids.createTitle }, t('sources.createTitle')),
      h(Field, { id: ids.createName, label: t('sources.createName'), hint: t('sources.createNameHint') },
        h('input', {
          id: ids.createName, className: 'ckb-input', type: 'text', value: newName,
          autoComplete: 'off', autoFocus: true, disabled: Boolean(busy),
          'aria-describedby': `${ids.createName}-hint`,
          onChange: event => setNewName(event.target.value),
        })),
      h(Field, { id: ids.createId, label: t('sources.createId'), hint: t('sources.createIdHint') },
        h('input', {
          id: ids.createId, className: 'ckb-input', type: 'text', value: newId,
          autoComplete: 'off', spellCheck: false, placeholder: t('sources.createIdPlaceholder'),
          disabled: Boolean(busy),
          'aria-describedby': `${ids.createId}-hint`,
          onChange: event => setNewId(event.target.value.toLowerCase()),
          onKeyDown: event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              createSource()
            }
          },
        })),
      h('div', { className: 'ckb-row' },
        h('button', {
          type: 'button', className: 'ckb-btn', 'data-kind': 'primary',
          disabled: Boolean(busy) || !/^[a-z][a-z0-9-]*$/.test(newId.trim()),
          onClick: createSource,
        }, t('sources.create')),
        h('button', {
          type: 'button', className: 'ckb-btn', 'data-kind': 'quiet',
          disabled: Boolean(busy), onClick: () => setCreateOpen(false),
        }, t('action.cancel'))))
        : null)
      const busyLabel = busy === 'check' ? t('test.checking')
        : busy === 'import' ? t('job.starting')
          : busy === 'importBase' ? t('sources.importing')
            : busy === 'export' ? t('base.exportStarting')
              : busy === 'exportCancel' ? t('base.exportCancelling')
                : busy === 'pickFolder' ? t('base.exportPicking')
                  : busy === 'clear' ? t('sources.clearing')
                    : busy === 'stop' ? t('job.stopping')
                      : busy === 'registry' ? t('sources.working') : ''
      if (!state) {
        if (list.length === 0 && !loadError) {
          return h('div', { className: 'ckb', role: 'region', 'aria-labelledby': ids.title },
            h('div', null,
              h('h2', { id: ids.title }, t('section.title')),
              h('p', { className: 'ckb-intro' }, t('sources.emptyIntro'))),
            notice
              ? h('div', {
                className: 'ckb-status', 'data-tone': notice.tone, role: 'status', 'aria-live': 'polite',
              },
              h('span', null, notice.text),
              notice.detail ? h('span', { className: 'ckb-detail' }, notice.detail) : null)
              : null,
            h('div', { className: 'ckb-block' },
              h('h3', { className: 'ckb-title' }, t('sources.title')),
              h('p', { className: 'ckb-hint' }, t('sources.emptyHint')),
              h('div', { className: 'ckb-row' },
                h('button', {
                  type: 'button', className: 'ckb-btn', 'data-kind': 'primary',
                  disabled: Boolean(busy), onClick: openCreate,
                }, t('sources.new'))),
              h('p', { className: 'ckb-hint' }, t('sources.importHint')),
              importRow(),
              createDialog()),
            busyLabel ? h('p', { className: 'ckb-hint', role: 'status', 'aria-live': 'polite' }, busyLabel) : null,
            h('style', null, CSS))
        }
        const failure = loadError || { text: t('section.loadFailed'), detail: '' }
        return h('div', { className: 'ckb' },
          h('h2', { id: ids.title }, t('section.title')),
          h('div', { className: 'ckb-status', 'data-tone': 'error', role: 'alert' },
            h('span', null, failure.text),
            failure.detail ? h('span', { className: 'ckb-detail' }, failure.detail) : null),
          h('button', {
            type: 'button', className: 'ckb-btn', onClick: () => { void boot() },
          }, t('action.reload')),
          h('style', null, CSS))
      }

      const storageLine = t('section.intro', {
        root: state.root || '—',
        count: state.articleCount ?? 0,
      })
      const selectedTotal = new Set(selected).size
      const savedCredential = auth === 'bearer' ? Boolean(state.tokenConfigured) : Boolean(state.basicConfigured)
      const canCheck = source === 'api'
        ? Boolean(baseUrl.trim()) && (savedCredential || (auth === 'bearer' ? Boolean(token.trim()) : Boolean(user.trim() && password)))
        : Boolean(filePath.trim())
      const canImport = running ? false : (source === 'api'
        ? Boolean(baseUrl.trim()) && savedCredential && (spacesAll || selectedTotal > 0 || spaces.length === 0)
        : Boolean(filePath.trim()) && (spacesAll || selectedTotal > 0 || spaces.length === 0))
      const blockedBy = canImport || running ? ''
        : source === 'api'
          ? (!baseUrl.trim() ? 'error.url.empty'
            : !savedCredential ? (auth === 'bearer' ? 'error.tokenMissing' : 'error.basicMissing')
              : 'error.noSpaces')
          : !filePath.trim() ? 'error.filePathMissing' : 'error.noSpaces'

      const progress = job?.progress || { done: 0, total: 0, space: '', percent: null }
      const jobLabel = !job || job.state === 'idle'
        ? t('job.idle')
        : job.state === 'running'
          ? (progress.total > 0
            ? t('job.running', { done: progress.done, total: progress.total })
            : t('job.runningUnknown', { done: progress.done }))
          : job.state === 'done' ? t('job.done')
            : job.state === 'cancelled' ? t('job.cancelled') : t('job.failed')
      const errorText = job?.error ? translateError(t, job.error) : null
      const taskView = (() => {
        if (!job?.task) return null
        if (job.task.state === 'created') return { tone: 'ok', text: t('task.created') }
        if (job.task.state === 'updated') return { tone: 'ok', text: t('task.updated') }
        if (job.task.state === 'pending') return { tone: 'idle', text: t('task.pending') }
        switch (job.task.code) {
          case 'task.unavailable': return { tone: 'warn', text: t('task.unavailable') }
          case 'task.rejected': return { tone: 'warn', text: t('task.rejected') }
          case 'task.pauseRejected': return { tone: 'warn', text: t('task.pauseRejected') }
          default: return { tone: 'warn', text: t('task.failed') }
        }
      })()

      const elapsedRaw = running ? clock - Date.parse(job.startedAt || '') : (job?.durationMs || 0)
      const elapsed = Number.isFinite(elapsedRaw) ? Math.max(0, elapsedRaw) : 0

      return h('div', { className: 'ckb', role: 'region', 'aria-labelledby': ids.title, 'aria-busy': busy ? 'true' : 'false' },

        h('div', null,
          h('h2', { id: ids.title }, t('section.title')),
          h('p', { className: 'ckb-intro' }, storageLine)),

        // ---- action feedback, directly under the page heading -------------
        notice
          ? h('div', {
            className: 'ckb-status', 'data-tone': notice.tone, role: 'status', 'aria-live': 'polite',
          },
          h('span', null, notice.text),
          notice.detail ? h('span', { className: 'ckb-detail' }, notice.detail) : null)
          : h('div', { className: 'ckb-sr', role: 'status', 'aria-live': 'polite' }, announce),

        // ---- source list --------------------------------------------------
        h('div', { className: 'ckb-block' },
          h('div', { className: 'ckb-inline' },
            h('h3', { className: 'ckb-title' }, t('sources.title')),
            h('span', { className: 'ckb-count' }, t('sources.count', { count: list.length }))),
          h('p', { className: 'ckb-hint' }, t('sources.hint')),
          h('label', { className: 'ckb-sr', htmlFor: ids.pick }, t('sources.title')),
          h('select', {
            id: ids.pick,
            className: 'ckb-input',
            value: selectedId,
            disabled: Boolean(busy) || running,
            onChange: event => selectSource(event.target.value),
          }, list.map(row => h('option', { key: row.id, value: row.id },
            `${row.name} · ${t(`source.${row.source}`)} · ${t('sources.articles', { count: row.articleCount })}`
            + (row.id === defaultId ? ` · ${t('sources.defaultBadge')}` : '')))),
          h('div', { className: 'ckb-meta' },
            h('span', { className: 'ckb-key', title: state.root }, state.id),
            state.isDefault ? h('span', { className: 'ckb-badge' }, t('sources.defaultBadge')) : null,
            h('span', null, state.root)),
          h('div', { className: 'ckb-row' },
            h('button', {
              type: 'button', className: 'ckb-btn', disabled: Boolean(busy) || running,
              onClick: openCreate,
            }, t('sources.new')),
            h('button', {
              type: 'button', className: 'ckb-btn', disabled: Boolean(busy) || running,
              onClick: makeDefault,
            }, t('sources.makeDefault')),
            confirmAction === 'delete'
              ? [
                h('button', {
                  key: 'yes', type: 'button', className: 'ckb-btn', 'data-kind': 'danger',
                  disabled: Boolean(busy) || running, onClick: deleteSource,
                }, t('sources.deleteYes')),
                h('button', {
                  key: 'no', type: 'button', className: 'ckb-btn', 'data-kind': 'quiet',
                  disabled: Boolean(busy), onClick: () => setConfirmAction(''),
                }, t('action.cancel')),
              ]
              : h('button', {
                key: 'delete', type: 'button', className: 'ckb-btn', 'data-kind': 'quiet',
                disabled: Boolean(busy) || running,
                onClick: () => setConfirmAction('delete'),
              }, t('sources.delete'))),
          confirmAction === 'delete'
            ? h('p', { className: 'ckb-hint ckb-danger' }, t('sources.deleteHint'))
            : null,
          h('p', { className: 'ckb-hint' }, t('sources.importHint')),
          importRow(),
          createDialog()),
        busyLabel ? h('p', { className: 'ckb-hint', role: 'status', 'aria-live': 'polite' }, busyLabel) : null,

        // ---- one source ---------------------------------------------------
        h('div', { className: 'ckb-block' },
          h('h3', { className: 'ckb-title' }, t('sources.editor', { name: name || selectedId })),
          h(Field, { id: ids.name, label: t('field.name'), hint: t('field.nameHint') },
            h('input', {
              id: ids.name, className: 'ckb-input', type: 'text', value: name,
              placeholder: t('field.namePlaceholder'), autoComplete: 'off', disabled: running,
              'aria-describedby': `${ids.name}-hint`,
              onChange: event => setName(event.target.value),
            })),

          h('fieldset', { className: 'ckb-block', style: { border: 0, padding: 0, margin: 0 } },
            h('legend', { className: 'ckb-title', style: { padding: 0 } }, t('source.legend')),
            h('div', { className: 'ckb-choices' },
              SOURCES.map(value => h('label', { key: value, className: 'ckb-choice', htmlFor: `${ids.source}-${value}` },
                h('input', {
                  id: `${ids.source}-${value}`, type: 'radio', name: ids.source, value,
                  checked: source === value, disabled: running || Boolean(busy),
                  onChange: () => setSource(value),
                }),
                t(`source.${value}`)))),
            h('p', { className: 'ckb-hint' }, t(source === 'api' ? 'source.apiHint' : 'source.fileHint'))),

          h('div', { className: 'ckb-panel' },
            source === 'api' ? [
              h(Field, {
                key: 'url',
                id: ids.baseUrl,
                label: t('field.baseUrl'),
                hint: state.urlLocked
                  ? (state.imported ? t('field.baseUrlImported') : t('field.baseUrlLocked'))
                  : t('field.baseUrlHint'),
              },
              h('input', {
                id: ids.baseUrl, className: 'ckb-input', type: 'url', inputMode: 'url',
                value: baseUrl, placeholder: t('field.baseUrlPlaceholder'),
                autoComplete: 'off', spellCheck: false, disabled: running,
                readOnly: Boolean(state.urlLocked),
                'aria-describedby': `${ids.baseUrl}-hint`,
                onChange: event => setBaseUrl(event.target.value),
              })),
              h('fieldset', { key: 'auth', className: 'ckb-field', style: { border: 0, margin: 0 } },
                h('legend', { className: 'ckb-label', style: { padding: 0 } }, t('auth.legend')),
                h('div', { className: 'ckb-choices' },
                  AUTH_MODES.map(mode => h('label', { key: mode, className: 'ckb-choice', htmlFor: `${ids.auth}-${mode}` },
                    h('input', {
                      id: `${ids.auth}-${mode}`, type: 'radio', name: ids.auth, value: mode,
                      checked: auth === mode, disabled: running || Boolean(busy),
                      onChange: () => setAuth(mode),
                    }),
                    t(`auth.${mode}`)))),
                h('p', { className: 'ckb-hint' }, t(auth === 'bearer' ? 'auth.bearerHint' : 'auth.basicHint'))),

              auth === 'bearer'
                ? h(Field, { key: 'token', id: ids.token, label: t('field.token'), hint: t('field.tokenHint') },
                  h('div', { className: 'ckb-row' },
                    h('input', {
                      id: ids.token, className: 'ckb-input ckb-grow', type: 'password',
                      value: token, autoComplete: 'off',
                      placeholder: state.tokenConfigured ? t('field.tokenStored') : t('field.tokenEmpty'),
                      disabled: running || busy === 'credential' || state.credentialsAvailable === false,
                      'aria-describedby': `${ids.token}-hint`,
                      onChange: event => setToken(event.target.value),
                    }),
                    h('button', {
                      type: 'button', className: 'ckb-btn', onClick: saveCredential,
                      disabled: running || busy === 'credential' || !token.trim() || state.credentialsAvailable === false,
                    }, t('field.tokenSave')),
                    h('button', {
                      type: 'button', className: 'ckb-btn', 'data-kind': 'quiet', onClick: deleteCredential,
                      disabled: running || busy === 'credential' || !state.tokenConfigured || state.credentialsAvailable === false,
                    }, t('field.tokenDelete'))),
                  state.credentialsAvailable === false ? t('error.credentials') : null)
                : h(Field, { key: 'basic', id: ids.user, label: t('field.user'), hint: t('field.passwordHint') },
                  h('div', { className: 'ckb-row' },
                    h('input', {
                      id: ids.user, className: 'ckb-input ckb-grow', type: 'text',
                      value: user, autoComplete: 'username', spellCheck: false,
                      placeholder: state.basicUser || t('field.userPlaceholder'),
                      disabled: running || busy === 'credential' || state.credentialsAvailable === false,
                      'aria-describedby': `${ids.user}-hint`,
                      onChange: event => setUser(event.target.value),
                    }),
                    h('input', {
                      id: ids.password, className: 'ckb-input ckb-grow', type: 'password',
                      value: password, autoComplete: 'current-password',
                      placeholder: state.basicConfigured ? t('field.passwordStored') : t('field.password'),
                      disabled: running || busy === 'credential' || state.credentialsAvailable === false,
                      'aria-label': t('field.password'),
                      onChange: event => setPassword(event.target.value),
                    }),
                    h('button', {
                      type: 'button', className: 'ckb-btn', onClick: saveCredential,
                      disabled: running || busy === 'credential' || !user.trim() || !password
                        || state.credentialsAvailable === false,
                    }, t('action.saveCredentials')),
                    h('button', {
                      type: 'button', className: 'ckb-btn', 'data-kind': 'quiet', onClick: deleteCredential,
                      disabled: running || busy === 'credential' || !state.basicConfigured || state.credentialsAvailable === false,
                    }, t('action.deleteCredentials'))),
                  state.credentialsAvailable === false ? t('error.credentials') : null)
            ] : [
              h(Field, { key: 'file', id: ids.filePath, label: t('field.filePath'), hint: t('field.filePathHint') },
                h('input', {
                  id: ids.filePath, className: 'ckb-input', type: 'text', value: filePath,
                  placeholder: t('field.filePathPlaceholder'),
                  autoComplete: 'off', spellCheck: false, disabled: running,
                  'aria-describedby': `${ids.filePath}-hint`,
                  onChange: event => setFilePath(event.target.value),
                }))
            ]),

          h('div', { className: 'ckb-row' },
            h('button', {
              type: 'button', className: 'ckb-btn', disabled: Boolean(busy) || running || !canCheck,
              onClick: checkSource,
            }, source === 'api' ? t('action.checkConnection') : t('action.checkFile')),
            h('button', {
              type: 'button', className: 'ckb-btn', disabled: Boolean(busy) || running,
              onClick: saveSettings,
            }, t('action.save')))),

        // ---- spaces -------------------------------------------------------
        h('div', { className: 'ckb-block' },
          h('div', { className: 'ckb-inline' },
            h('h3', { className: 'ckb-title' }, t('spaces.title')),
            h('span', { className: 'ckb-count' }, spaces.length
              ? t('spaces.selected', { selected: selectedTotal, total: spaces.length })
              : t('spaces.selectedOnly', { selected: selectedTotal }))),
          h('label', { className: 'ckb-choice' },
            h('input', {
              type: 'checkbox', checked: spacesAll, disabled: running,
              onChange: event => setSpacesAll(event.target.checked),
            }),
            t('spaces.all')),
          spacesAll ? h('p', { className: 'ckb-hint' }, t('spaces.allHint')) : null,
          source === 'file' && spaces.length === 0
            ? h('p', { className: 'ckb-hint' }, t('spaces.fileAllHint'))
            : null,

          h('div', { className: 'ckb-row' },
            h('label', { className: 'ckb-sr', htmlFor: ids.filter }, t('spaces.filter')),
            h('input', {
              id: ids.filter, className: 'ckb-input ckb-grow', type: 'search',
              value: filter, placeholder: t('spaces.filter'), 'aria-label': t('spaces.filter'),
              disabled: spaces.length === 0,
              onChange: event => setFilter(event.target.value),
            }),
            h('button', {
              type: 'button', className: 'ckb-btn',
              disabled: spaces.length === 0 || running || filtered.length === 0,
              onClick: selectAllFiltered,
            }, t('spaces.selectAll')),
            h('button', {
              type: 'button', className: 'ckb-btn',
              disabled: selectedTotal === 0 || running, onClick: clearSelection,
            }, t('spaces.clear'))),

          spaces.length === 0
            ? (source === 'file' ? null : h('p', { className: 'ckb-hint' }, t('spaces.emptyBoth')))
            : filtered.length === 0
              ? h('p', { className: 'ckb-hint' }, t('spaces.filteredEmpty'))
              : h(SpaceList, {
                rows: filtered,
                selected,
                running,
                disabled: spacesAll,
                label: t('aria.spaces'),
                onToggle: toggleSpace,
                t,
              })),

        // ---- schedule -----------------------------------------------------
        h('div', { className: 'ckb-block' },
          h('h3', { className: 'ckb-title' }, t('schedule.title')),
          h('p', { className: 'ckb-hint' }, t('schedule.hint')),
          source === 'file' ? h('p', { className: 'ckb-hint' }, t('schedule.fileHint')) : null,
          h('div', { className: 'ckb-row' },
            h('label', { className: 'ckb-choice', htmlFor: ids.incremental }, t('schedule.incremental')),
            h('input', {
              id: ids.incremental, className: 'ckb-input ckb-num', type: 'number', min: 1, max: 3650,
              value: incrementalDays, disabled: running,
              onChange: event => setIncrementalDays(Number(event.target.value) || 7),
            })),
          h('div', { className: 'ckb-row' },
            h('label', { className: 'ckb-choice', htmlFor: ids.full }, t('schedule.full')),
            h('input', {
              id: ids.full, className: 'ckb-input ckb-num', type: 'number', min: 1, max: 3650,
              value: fullDays, disabled: running,
              onChange: event => setFullDays(Number(event.target.value) || 30),
            })),
          h('p', { className: 'ckb-hint' }, state.nextRun
            ? t('schedule.dueNow', { mode: t(`mode.${state.nextRun}`) })
            : t('schedule.nothingDue'))),

        // ---- import -------------------------------------------------------
        h('div', { className: 'ckb-block' },
          h('h3', { className: 'ckb-title' }, t('job.title')),
          h('div', { className: 'ckb-row' },
            h('button', {
              ref: importRef,
              type: 'button', className: 'ckb-btn', 'data-kind': 'primary',
              disabled: !canImport || Boolean(busy),
              onClick: () => startImport(false),
            }, source === 'file' ? t('action.importFile') : t('action.importIncremental')),
            source === 'file'
              ? null
              : h('button', {
                type: 'button', className: 'ckb-btn',
                disabled: !canImport || Boolean(busy), onClick: () => startImport(true),
              }, t('action.importFull')),
            running
              ? h('button', {
                ref: stopRef,
                type: 'button', className: 'ckb-btn', onClick: stopImport, disabled: busy === 'stop',
              }, t('action.stop'))
              : null),
          blockedBy ? h('p', { className: 'ckb-hint' }, t(blockedBy)) : null,

          h('div', { className: 'ckb-progress-head' },
            h('span', { className: 'ckb-progress-num' }, jobLabel),
            running && progress.space
              ? h('span', { className: 'ckb-hint' }, t('job.space', { space: progress.space }))
              : null,
            job?.startedAt
              ? h('span', { className: 'ckb-hint' }, t('job.elapsed', { duration: formatDuration(elapsed, t) }))
              : null),
          running || progress.total > 0
            ? h(Bar, { progress, label: t('aria.progress') })
            : null,
          running ? h('p', { className: 'ckb-hint' }, progress.total > 0
            ? t('job.running', { done: progress.done, total: progress.total })
            : t('job.runningUnknown', { done: progress.done })) : null,

          errorText || taskView
            ? h('div', {
              className: 'ckb-status',
              'data-tone': errorText ? 'error' : taskView.tone,
              role: 'status', 'aria-live': 'polite',
            },
            errorText ? h('span', null, errorText.text) : null,
            errorText && errorText.detail ? h('span', { className: 'ckb-detail' }, errorText.detail) : null,
            taskView ? h('span', null, taskView.text) : null,
            job?.task?.code === 'task.failed' && job?.task?.detail
              ? h('span', { className: 'ckb-detail' }, job.task.detail)
              : null)
            : null,

          job?.stats
            ? h('p', { className: 'ckb-hint' }, t('last.counts', {
              added: job.stats.added, changed: job.stats.changed,
              deprecated: job.stats.deprecated, skipped: job.stats.skipped,
            }))
            : null),

        // ---- last run -----------------------------------------------------
        h('div', { className: 'ckb-block' },
          h('h3', { className: 'ckb-title' }, t('last.title')),
          state.lastRun
            ? h('div', { className: 'ckb-meta' },
              h('span', null, t('last.line', {
                when: formatDateTime(state.lastRun.finishedAt, locale),
                mode: t(`mode.${state.lastRun.mode || 'full'}`),
                state: t(`state.${state.lastRun.state || 'done'}`),
              })),
              state.lastRun.stats
                ? h('span', null, t('last.counts', {
                  added: state.lastRun.stats.added, changed: state.lastRun.stats.changed,
                  deprecated: state.lastRun.stats.deprecated, skipped: state.lastRun.stats.skipped,
                }))
                : null,
              state.lastRun.error
                ? h('span', { className: 'ckb-status', 'data-tone': 'error' },
                  t('last.error', { error: translateError(t, state.lastRun.error).text }))
                : null)
            : h('p', { className: 'ckb-hint' }, t('last.none')),
          state.lastRun
            ? h('p', { className: 'ckb-hint' }, state.taskId
              ? t('last.taskSaved', { title: t('task.title', {
                source: name || selectedId,
                date: formatDateTime(state.lastRun.finishedAt, locale),
              }) })
              : t('last.taskMissing'))
            : null),

        // ---- workspaces ---------------------------------------------------
        h('div', { className: 'ckb-block' },
          h('h3', { className: 'ckb-title' }, t('workspace.title')),
          h('p', { className: 'ckb-hint' }, t('workspace.hint')),
          h('p', { className: 'ckb-hint' }, t('workspace.defaultHint', {
            name: list.find(row => row.id === defaultId)?.name || defaultId,
          })),
          workspaces.length === 0
            ? h('p', { className: 'ckb-hint' }, t('workspace.empty'))
            : workspaces.map(workspace => h('div', { key: workspace.id, className: 'ckb-ws' },
              h('div', { className: 'ckb-grow' },
                h('div', { className: 'ckb-name' }, workspace.title),
                h('div', { className: 'ckb-ws-path' }, workspace.path)),
              h('div', { className: 'ckb-row' },
                list.map(row => h('label', { key: row.id, className: 'ckb-choice' },
                  h('input', {
                    type: 'checkbox',
                    checked: (workspace.sources || []).includes(row.id),
                    disabled: Boolean(busy) || running,
                    onChange: event => toggleWorkspaceSource(workspace.id, row.id, event.target.checked),
                  }),
                  row.name)))))),

        // ---- the base itself ----------------------------------------------
        h('div', { className: 'ckb-block' },
          h('h3', { className: 'ckb-title' }, t('base.title')),
          h('p', { className: 'ckb-hint' }, t('base.count', { count: state.articleCount ?? 0 })),

          exportOpen
            ? h('div', {
              className: 'ckb-dialog',
              role: 'group',
              'aria-labelledby': ids.exportTitle,
              onKeyDown: event => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  setExportOpen(false)
                  setExportConflict(null)
                }
              },
            },
            h('h4', { id: ids.exportTitle }, t('base.exportTitle')),
            h(Field, {
              id: ids.exportDir, label: t('base.exportFolder'), hint: t('base.exportFolderHint'),
            },
            h('div', { className: 'ckb-row' },
              h('input', {
                id: ids.exportDir, className: 'ckb-input ckb-grow', type: 'text', value: exportDir,
                autoComplete: 'off', spellCheck: false, disabled: Boolean(busy) || picking,
                'aria-describedby': `${ids.exportDir}-hint`,
                onChange: event => {
                  setExportDir(event.target.value)
                  setExportConflict(null)
                },
              }),
              h('button', {
                type: 'button', className: 'ckb-btn', disabled: Boolean(busy) || picking,
                onClick: pickExportDir,
              }, picking ? t('base.exportPicking') : t('base.exportBrowse')))),
            h(Field, {
              id: ids.exportName, label: t('base.exportName'), hint: t('base.exportNameHint'),
            },
            h('input', {
              id: ids.exportName, className: 'ckb-input', type: 'text', value: exportName,
              autoComplete: 'off', spellCheck: false, autoFocus: true,
              disabled: Boolean(busy),
              'aria-describedby': `${ids.exportName}-hint`,
              onChange: event => {
                setExportName(event.target.value)
                setExportConflict(null)
              },
              onKeyDown: event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  startExportAction()
                }
              },
            })),
            h('div', { className: 'ckb-row' },
              h('button', {
                type: 'button', className: 'ckb-btn', 'data-kind': 'primary',
                disabled: Boolean(busy) || !exportDir.trim() || !exportName.trim(),
                onClick: () => startExportAction(),
              }, t('base.exportSave')),
              h('button', {
                type: 'button', className: 'ckb-btn', 'data-kind': 'quiet',
                disabled: Boolean(busy),
                onClick: () => {
                  setExportOpen(false)
                  setExportConflict(null)
                },
              }, t('action.cancel'))))
            : null,

          exportConflict
            ? h('div', {
              className: 'ckb-dialog',
              role: 'dialog',
              'aria-modal': 'false',
              'aria-labelledby': ids.exportConflictTitle,
            },
            h('h4', { id: ids.exportConflictTitle }, t('base.exportConflictTitle')),
            h('p', { className: 'ckb-hint' }, t('base.exportConflict', { name: exportConflict.fileName })),
            h('div', { className: 'ckb-row' },
              h('button', {
                type: 'button', className: 'ckb-btn', 'data-kind': 'danger',
                disabled: Boolean(busy), onClick: confirmOverwrite,
              }, t('base.exportReplace')),
              h('button', {
                type: 'button', className: 'ckb-btn', 'data-kind': 'quiet',
                disabled: Boolean(busy), autoFocus: true,
                onClick: () => setExportConflict(null),
              }, t('action.cancel'))))
            : null,

          exportJob?.state === 'running'
            ? h('div', { className: 'ckb-progress', role: 'status', 'aria-live': 'polite' },
              h('div', { className: 'ckb-progress-head' },
                h('span', { className: 'ckb-progress-num' },
                  (exportJob.progress?.total ?? 0) > 0
                    ? t('base.exporting', {
                      done: formatBytes(exportJob.progress.done, t) || '0',
                      total: formatBytes(exportJob.progress.total, t) || '0',
                    })
                    : t('base.exportPreparing')),
                exportJob.progress?.percent != null
                  ? h('span', null, `${exportJob.progress.percent}%`)
                  : null,
                h('button', {
                  type: 'button', className: 'ckb-btn', 'data-kind': 'quiet',
                  disabled: busy === 'exportCancel', onClick: cancelExportAction,
                }, t('base.exportCancel'))),
              h(Bar, {
                progress: exportJob.progress || { percent: null, done: 0, total: 0 },
                label: t('base.exportProgress'),
              }))
            : null,

          exportJob && exportJob.state !== 'running' && exportJob.state !== 'idle'
            ? h('div', {
              className: exportJob.state === 'done' ? 'ckb-export-result' : 'ckb-export-result ckb-danger',
              role: 'status',
            },
            h('span', null, exportJob.state === 'done'
              ? t('base.exported', {
                path: exportJob.path,
                count: exportJob.articles ?? 0,
                size: formatBytes(exportJob.bytes ?? 0, t) || '',
              })
              : exportJob.state === 'cancelled'
                ? t('base.exportCancelled')
                : translateError(t, exportJob.error || { code: 'error.exportFailed' }).text),
            exportJob.state === 'done'
              ? h('button', {
                type: 'button', className: 'ckb-btn', 'data-kind': 'quiet',
                disabled: busy === 'reveal', onClick: revealExport,
              }, t('base.reveal'))
              : null)
            : null,

          h('div', { className: 'ckb-row' },
            h('button', {
              type: 'button', className: 'ckb-btn',
              disabled: Boolean(busy) || running || exportJob?.state === 'running'
                || !((state.articleCount ?? 0) > 0),
              onClick: openExport,
            }, t('base.export')),
            confirmAction === 'clear'
              ? [
                h('button', {
                  key: 'yes', type: 'button', className: 'ckb-btn', 'data-kind': 'danger',
                  disabled: Boolean(busy) || running || !((state.articleCount ?? 0) > 0),
                  onClick: clearBase,
                }, t('base.clearYes')),
                h('button', {
                  key: 'no', type: 'button', className: 'ckb-btn', 'data-kind': 'quiet',
                  disabled: Boolean(busy), onClick: () => setConfirmAction(''),
                }, t('action.cancel')),
              ]
              : h('button', {
                key: 'clear', type: 'button', className: 'ckb-btn', 'data-kind': 'quiet',
                disabled: Boolean(busy) || running || !((state.articleCount ?? 0) > 0),
                onClick: () => setConfirmAction('clear'),
              }, t('base.clear'))),
          confirmAction === 'clear'
            ? h('p', { className: 'ckb-hint ckb-danger' }, t('base.clearHint'))
            : h('p', { className: 'ckb-hint' }, t('base.exportHint'))),

        // ---- engine output ------------------------------------------------
        h('details', { className: 'ckb-log' },
          h('summary', null, t('log.title')),
          h('div', { className: 'ckb-log-body' },
            h('p', { className: 'ckb-hint' }, t('log.hint')),
            job && job.state !== 'idle'
              ? h('p', { className: 'ckb-hint' },
                [jobLabel, taskView?.text, errorText?.text].filter(Boolean).join(' · '))
              : null,
            job?.lines?.length
              ? h('pre', { className: 'ckb-log-text' }, job.lines.join('\n'))
              : h('p', { className: 'ckb-hint' }, t('log.empty')))),

        h('style', null, CSS))
    }

    // The dictionaries and the active locale come from `apply`; the component
    // reads them through these module-scope handles so a slot remount keeps them.
    let fallbackDictionary = null
    let localeService = null

    function currentLocale() {
      try {
        return localeService?.getSnapshot?.().active || 'en'
      } catch {
        return 'en'
      }
    }

    async function loadDictionary(language, deadline) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (Date.now() > deadline) return null
        try {
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          const timer = controller ? setTimeout(() => controller.abort(), 2500) : null
          const response = await fetch(`${API}/locale/${language}.json`, {
            headers: { accept: 'application/json' },
            signal: controller ? controller.signal : undefined,
          })
          if (timer) clearTimeout(timer)
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const raw = await response.json()
          const flat = {}
          for (const [key, value] of Object.entries(raw)) {
            if (typeof value === 'string') flat[key] = value
          }
          return flat
        } catch {
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
        }
      }
      return null
    }

    /** Load every dictionary the plugin ships, within one deadline. */
    async function loadDictionaries(deadline) {
      const dictionaries = {}
      for (const language of LANGUAGES) {
        const dict = await loadDictionary(language, deadline)
        if (dict && Object.keys(dict).length) dictionaries[language] = dict
      }
      return dictionaries
    }

    return {
      inject: ['slots', 'locale'],
      async apply(ctx) {
        localeService = ctx.locale
        // Bounded so a slow Host route cannot keep the Settings entry from
        // appearing; the retry below repairs the labels if it was too slow.
        const initial = await loadDictionaries(Date.now() + 6000)
        fallbackDictionary = initial.en || initial.ru || {}
        const missing = LANGUAGES.filter(language => !initial[language])
        if (missing.length) {
          ctx.logger?.warn?.(`knowledge-base: locale dictionaries not yet available (${missing.join(', ')})`)
        }

        // One owner for every dictionary registration: the first batch plus
        // whatever a retry brings later. A registration bumps the locale
        // revision, so the navigation label repairs itself without a reload.
        ctx.effect(() => {
          const registered = new Set()
          const disposers = []
          const add = dictionaries => {
            for (const [language, dict] of Object.entries(dictionaries)) {
              if (registered.has(language) || !dict || Object.keys(dict).length === 0) continue
              registered.add(language)
              disposers.push(ctx.locale.register(NS, language, dict))
            }
            if (!fallbackDictionary || Object.keys(fallbackDictionary).length === 0) {
              fallbackDictionary = dictionaries.en || dictionaries.ru || {}
            }
          }
          add(initial)

          let timer = null
          let attempts = 0
          if (LANGUAGES.some(language => !registered.has(language))) {
            // The page can load while the Host half is still starting or being
            // reinstalled. Keep asking for a while instead of staying on keys.
            timer = setInterval(async () => {
              attempts += 1
              const again = await loadDictionaries(Date.now() + 4000)
              const fresh = {}
              for (const language of LANGUAGES) {
                if (!registered.has(language) && again[language]) fresh[language] = again[language]
              }
              if (Object.keys(fresh).length) add(fresh)
              if (LANGUAGES.every(language => registered.has(language)) || attempts >= 20) {
                clearInterval(timer)
                timer = null
              }
            }, 4000)
          }

          return () => {
            if (timer !== null) clearInterval(timer)
            disposers.forEach(dispose => dispose())
          }
        }, 'knowledge-base: dictionaries')

        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'knowledge-base',
          order: 20,
          locale: NS,
          label: () => t('nav.label'),
        }, Section))
      },
    }
  },
})
