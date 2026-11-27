import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { Button, IconRefreshOutlineRegular, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  cancelEngineLogin, checkEngineUpdate, listEngineProfiles, logoutEngineCli,
  mutateEngineProfile, pollEngineLogin, readActiveEngineLogin, startEngineLogin, submitEngineLoginCode, updateEngineCli,
} from './chat-state.mjs'
import { EngineLogo } from './EngineHero.jsx'

function parseEnvLines(text) {
  const env = {}
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const k = trimmed.slice(0, eq).trim()
    const v = trimmed.slice(eq + 1).trim()
    if (k && v) env[k] = v
  }
  return env
}

const isOAuthProfile = profile => profile?.kind === 'default' || profile?.kind === 'isolated'
const awaitsCode = login => login?.needsCode &&
  (login.status === 'waiting_auth' || (login.engineId !== 'agy' && login.status === 'waiting_url'))

function logoutLabel(engineId, profile) {
  if (engineId !== 'agy') return 'engineSettings.logout'
  return profile.kind === 'default' ? 'engineSettings.agyLogoutNative' : 'engineSettings.agyLogoutIsolated'
}

const agyLogoutMessages = {
  agy_native_logout_manual: 'engineSettings.agyLogoutManual',
  agy_logout_storage: 'engineSettings.agyLogoutStorage',
}

export function EngineSettings({ engineSource, focusedEngine, t }) {
  const { engines, status, operations } = useSyncExternalStore(engineSource.subscribe, engineSource.getSnapshot)
  const headingId = useId()
  const [loggingOutKey, setLoggingOutKey] = useState(null)
  const [expandedId, setExpandedId] = useState(focusedEngine || null)
  const [profilesByEngine, setProfilesByEngine] = useState({})
  const [addingFor, setAddingFor] = useState(null)
  const [addingKind, setAddingKind] = useState('env')
  const [newName, setNewName] = useState('')
  const [newEnvText, setNewEnvText] = useState('')
  const [editingProfile, setEditingProfile] = useState(null)
  const [editName, setEditName] = useState('')
  const [editKeyVal, setEditKeyVal] = useState('')
  const [editBaseUrl, setEditBaseUrl] = useState('')
  const [editEnvText, setEditEnvText] = useState('')
  const [loginJob, setLoginJob] = useState(null)
  const [startingLoginId, setStartingLoginId] = useState(null)
  const loginRequested = useRef(false)
  const pendingPopup = useRef(null)
  const closePendingPopup = () => {
    pendingPopup.current?.close()
    pendingPopup.current = null
  }
  useEffect(() => closePendingPopup, [])
  useEffect(() => {
    const popup = pendingPopup.current
    if (!popup || loginJob?.engineId !== 'agy' || !loginJob.authUrl) return
    try {
      const url = new URL(loginJob.authUrl)
      if (url.origin === 'https://accounts.google.com' && !popup.closed) {
        popup.location.replace(url.href)
        pendingPopup.current = null
      }
    } catch { /* The manual sign-in link remains available. */ } finally { closePendingPopup() }
  }, [loginJob?.engineId, loginJob?.authUrl])
  const [loginCode, setLoginCode] = useState('')
  const [submittingCode, setSubmittingCode] = useState(false)
  const [cancellingLogin, setCancellingLogin] = useState(false)
  const [notice, setNotice] = useState(null)
  const loginBusy = Boolean(startingLoginId || loginJob)

  const refreshProfiles = async engineId => {
    const list = await listEngineProfiles(engineId)
    setProfilesByEngine(prev => ({ ...prev, [engineId]: list }))
  }

  useEffect(() => {
    const controller = new AbortController()
    void readActiveEngineLogin(controller.signal).then(({ login }) => {
      if (login && !controller.signal.aborted && !loginRequested.current) setLoginJob(login)
    }).catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!focusedEngine) return
    setExpandedId(focusedEngine)
    void refreshProfiles(focusedEngine).catch(() => {})
  }, [focusedEngine])

  const loginEngineId = loginJob?.engineId
  const loginId = loginJob?.loginId
  useEffect(() => {
    if (!loginId) return
    let stopped = false
    let timer
    async function poll() {
      try {
        const res = await pollEngineLogin(loginEngineId, loginId)
        if (stopped) return
        if (res.status === 'done' || res.status === 'error' || res.status === 'cancelled') {
          closePendingPopup()
          setLoginJob(prev => prev?.loginId === loginId ? null : prev)
          setLoginCode('')
          if (res.status === 'done') {
            setNotice(null)
            void Promise.allSettled([engineSource.refresh(), refreshProfiles(loginEngineId)])
          } else if (res.status === 'error') {
            setNotice({ text: res.errorCode ? t(res.errorCode) : (res.error || t('request.failed')), error: true })
          }
          return
        }
        setLoginJob(prev => prev?.loginId === loginId ? res : prev)
      } catch (error) {
        if (stopped) return
        if (error.status === 404) {
          closePendingPopup()
          setLoginJob(prev => prev?.loginId === loginId ? null : prev)
          setLoginCode('')
          setNotice({ text: error.message || t('request.failed'), error: true })
          return
        }
      }
      timer = setTimeout(poll, 750)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [loginEngineId, loginId, engineSource, t])

  const toggleProfiles = async engineId => {
    if (expandedId === engineId) {
      setExpandedId(null)
      return
    }
    setExpandedId(engineId)
    try { await refreshProfiles(engineId) } catch {}
  }

  const handleCheck = async id => {
    setNotice(null)
    try {
      await engineSource.runOperation(id, 'check', () => checkEngineUpdate(id))
    } catch (err) {
      setNotice({ text: err.message || t('request.failed'), error: true })
    }
  }

  const handleUpdate = async id => {
    setNotice(null)
    try {
      const res = await engineSource.runOperation(id, 'update', () => updateEngineCli(id))
      if (res?.status?.restartRequired) {
        setNotice({ text: t('engine.restartNeeded'), error: false })
      }
    } catch (err) {
      setNotice({ text: err.message || t('request.failed'), error: true })
    }
  }

  const handleStartLogin = async (engineId, { profileId, createProfile } = {}) => {
    if (loginRequested.current || startingLoginId || loginJob) return
    loginRequested.current = true
    if (engineId === 'agy') {
      try {
        const popup = window.open('about:blank', '_blank')
        if (popup) {
          pendingPopup.current = popup
          popup.opener = null
          popup.document.title = t('engineSettings.startingLogin')
          popup.document.body.textContent = t('engineSettings.startingLogin')
        }
      } catch { closePendingPopup() }
    }
    setStartingLoginId(engineId)
    setNotice(null)
    setLoginCode('')
    try {
      const res = await startEngineLogin(engineId, { profileId, createProfile })
      setLoginJob({ engineId, ...res })
    } catch (err) {
      closePendingPopup()
      setNotice({ text: err.message || t('request.failed'), error: true })
    } finally {
      loginRequested.current = false
      setStartingLoginId(null)
    }
  }

  const handleSubmitCode = async event => {
    event.preventDefault()
    if (!awaitsCode(loginJob) || !loginCode.trim() || submittingCode || cancellingLogin) return
    setSubmittingCode(true)
    try {
      await submitEngineLoginCode(loginJob.engineId, loginJob.loginId, loginCode.trim())
      setNotice(null)
      setLoginCode('')
    } catch (err) {
      setNotice({ text: err.code === 'oauth_callback_invalid' ? t('engineSettings.oauthCallback') : err.message || t('request.failed'), error: true })
    } finally {
      setSubmittingCode(false)
    }
  }

  const handleCancelLogin = async () => {
    if (!loginJob || cancellingLogin) return
    const current = loginJob
    setCancellingLogin(true)
    try {
      await cancelEngineLogin(current.engineId, current.loginId)
      closePendingPopup()
      setLoginJob(prev => prev?.loginId === current.loginId ? null : prev)
      setLoginCode('')
    } catch (err) {
      setNotice({ text: err.message || t('request.failed'), error: true })
    } finally {
      setCancellingLogin(false)
    }
  }

  const handleLogout = async (engineId, profileId) => {
    const key = `${engineId}:${profileId}`
    if (loggingOutKey) return
    setLoggingOutKey(key)
    setNotice(null)
    try {
      await logoutEngineCli(engineId, profileId)
    } catch (err) {
      const message = agyLogoutMessages[err.code]
      setNotice({ text: message ? t(message) : err.message || t('request.failed'), error: true })
    } finally {
      await Promise.allSettled([engineSource.refresh(), ...(expandedId === engineId ? [refreshProfiles(engineId)] : [])])
      setLoggingOutKey(null)
    }
  }

  const handleCreateProfileForm = async engineId => {
    const name = newName.trim()
    if (!name) return
    setNotice(null)
    try {
      const list = await mutateEngineProfile(engineId, {
        action: 'create',
        name,
        kind: addingKind,
        ...(addingKind === 'env' ? { env: parseEnvLines(newEnvText) } : {}),
      })
      setProfilesByEngine(prev => ({ ...prev, [engineId]: list }))
      setAddingFor(null)
      setNewName('')
      setNewEnvText('')
      await engineSource.refresh()
    } catch (err) {
      setNotice({ text: err.message || t('request.failed'), error: true })
    }
  }

  const handleProfileAction = async (engineId, payload) => {
    setNotice(null)
    try {
      const list = await mutateEngineProfile(engineId, payload)
      setProfilesByEngine(prev => ({ ...prev, [engineId]: list }))
      await engineSource.refresh()
    } catch (err) {
      setNotice({ text: err.message || t('request.failed'), error: true })
    }
  }

  const startEditProfile = (engineId, prof) => {
    setEditingProfile({ engineId, prof })
    setEditName(prof.name || '')
    setEditKeyVal('')
    setEditBaseUrl(prof.baseUrl || prof.defaultBaseUrl || '')
    setEditEnvText('')
  }

  const handleSaveEdit = async () => {
    if (!editingProfile) return
    const { engineId, prof } = editingProfile
    const payload = { action: 'update', profileId: prof.id }
    if (prof.kind === 'isolated') {
      if (!editName.trim()) return
      payload.name = editName.trim()
    } else if (prof.kind === 'env') {
      const parsed = parseEnvLines(editEnvText)
      if (Object.keys(parsed).length) payload.env = parsed
    } else {
      if (prof.envKey && editKeyVal.trim()) payload.env = { [prof.envKey]: editKeyVal.trim() }
      payload.baseUrl = editBaseUrl.trim()
    }
    await handleProfileAction(engineId, payload)
    setEditingProfile(null)
  }

  const visibleEngines = focusedEngine ? engines.filter(item => item.id === focusedEngine) : engines

  return <section className="dchat-archive-settings" aria-labelledby={focusedEngine ? undefined : headingId}>
    {!focusedEngine && <div className="dchat-settings-header">
      <h2 id={headingId}>{t('engineSettings.title')}</h2>
      <Button variant="outline" size="sm" disabled={Boolean(operations?.size)}
        onClick={() => void handleCheck('all')}>
        {operations?.has('all') ? t('engine.checking') : t('engineSettings.checkAll')}
      </Button>
    </div>}
    {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'dchat-archive-error' : undefined}>
      {notice.text}
    </p>}
    {visibleEngines.length > 0 ? <ul className={focusedEngine ? 'dchat-archive-rows dchat-account-focused' : 'dchat-archive-rows'}>
      {visibleEngines.map(eng => {
        const s = eng.status || {}
        const isChecking = operations?.get(eng.id) === 'check' || operations?.has('all')
        const isUpdating = operations?.get(eng.id) === 'update'
        const profiles = profilesByEngine[eng.id] || eng.profiles || []
        const activeProfileId = eng.defaultProfileId || 'default'
        const activeProfile = profiles.find(item => item.id === activeProfileId)
        const isLoggingOut = loggingOutKey === `${eng.id}:${activeProfileId}`
        const isAgy = eng.id === 'agy'
        const isExpanded = Boolean(focusedEngine) || expandedId === eng.id
        const googleEmails = isAgy && isExpanded ? profiles.filter(item =>
          isOAuthProfile(item) && item.authenticated && item.account?.includes('@')).map(item => item.account.toLowerCase()) : []
        const repeatedGoogleAccount = new Set(googleEmails).size < googleEmails.length
        const accountText = s.account || s.authLabel
        const activeLoginHere = loginJob?.engineId === eng.id
        const startingLoginHere = startingLoginId === eng.id || (activeLoginHere && loginJob.status === 'waiting_url')
        const addButtons = <>
          {eng.canMultiOAuth && <Button variant={focusedEngine && isAgy ? 'primary' : 'outline'} size="sm" disabled={loginBusy || s.installed === false}
            onClick={() => void handleStartLogin(eng.id, { createProfile: true })}>
            + {t('engineSettings.addOAuth')}
          </Button>}
          {!isAgy && <Button variant={focusedEngine ? 'primary' : 'outline'} size="sm"
            onClick={() => { setAddingFor(eng.id); setAddingKind('env'); setNewName(''); setNewEnvText('') }}>
            + {t('engineSettings.addEnv')}
          </Button>}
        </>
        const addForm = addingFor === eng.id && <div className="dchat-profile-form" style={{ margin: focusedEngine ? '0 0 8px' : '6px 0' }}>
          <input type="text" className="dchat-profile-input" placeholder={t('engineSettings.profileName')} value={newName}
            onChange={e => setNewName(e.target.value)} />
          {addingKind === 'env' && <textarea rows={3} className="dchat-profile-input" placeholder={t('engineSettings.envVarHint')} value={newEnvText}
            onChange={e => setNewEnvText(e.target.value)} style={{ fontFamily: 'monospace' }} />}
          <div style={{ display: 'flex', gap: 6 }}>
            <Button variant="primary" size="sm" onClick={() => void handleCreateProfileForm(eng.id)}>{t('engineSettings.saveProfile')}</Button>
            <Button variant="outline" size="sm" onClick={() => setAddingFor(null)}>{t('cancel')}</Button>
          </div>
        </div>
        return <li className={focusedEngine ? 'dchat-account-focused-row' : 'dchat-archive-row dchat-engine-row'} key={eng.id}>
          <div className={focusedEngine ? 'dchat-account-modal-engine' : 'dchat-engine-header'}>
            <div className="dchat-archive-detail">
              <span className="dchat-engine-identity">
                <EngineLogo engine={eng.id} label={eng.label} icon={eng.meta?.icon} size={16} />
                <span>{eng.label}</span>
                {s.version && <span className="dchat-engine-version">v{s.version}</span>}
                {s.installed === false ? (
                  <span className="dchat-engine-status" data-tone="warn">
                    <StateDot state="warning" size={7} />{t('engine.notInstalled')}
                  </span>
                ) : s.authenticated === true ? (
                  <span className="dchat-engine-status">
                    <StateDot state="done" size={7} />{accountText || t('engineSettings.loggedIn')}
                  </span>
                ) : s.authenticated === false ? (
                  <span className="dchat-engine-status" data-tone="warn">
                    <StateDot state="warning" size={7} />{t('engine.notLoggedIn')}
                  </span>
                ) : null}
              </span>
              {!focusedEngine && (s.updateAvailable || s.restartRequired || s.error) && <div className="dchat-archive-meta">
                {s.updateAvailable && <span className="dchat-engine-pill" data-tone="update">
                  {t('engine.updateAvailable', { version: s.latestVersion })}
                </span>}
                {s.restartRequired && <span>{t('engine.restartNeeded')}</span>}
                {s.error && <span className="dchat-archive-error">{s.error}</span>}
              </div>}
            </div>
            {focusedEngine ? (addingFor !== eng.id && <div className="dchat-engine-actions">{addButtons}</div>) : <div className="dchat-engine-actions">
              {s.authenticated === false && eng.canLogin && isOAuthProfile(activeProfile) && <Button variant="primary" size="sm" disabled={loginBusy || isLoggingOut || s.installed === false}
                onClick={() => void handleStartLogin(eng.id, { profileId: activeProfileId })}>
                {t('engineSettings.login')}
              </Button>}
              {eng.canUpdate && s.updateAvailable && <Button variant="primary" size="sm"
                disabled={isChecking || isUpdating} onClick={() => void handleUpdate(eng.id)}>
                {isUpdating ? t('engine.updating') : t('engine.updateNow')}
              </Button>}
              <Button variant="outline" size="sm" aria-expanded={isExpanded} onClick={() => void toggleProfiles(eng.id)}>
                {t('engineSettings.profiles', { count: profiles.length || 1 })}
              </Button>
              {eng.canCheckUpdate && <Tooltip label={isChecking ? t('engine.checking') : t('engine.checkUpdate')} side="bottom">
                <Button variant="outline" size="sm" className="dchat-engine-icon-btn" disabled={isChecking || isUpdating}
                  aria-label={isChecking ? t('engine.checking') : t('engine.checkUpdate')}
                  onClick={() => void handleCheck(eng.id)}>
                  <IconRefreshOutlineRegular size={14} />
                </Button>
              </Tooltip>}
            </div>}
          </div>

          {s.installed === false && isExpanded && <div className="dchat-archive-error" role="status">
            {t('engine.cliMissing', { engine: eng.id })}
            {focusedEngine && eng.canCheckUpdate && <Button variant="outline" size="sm" disabled={isChecking || isUpdating}
              onClick={() => void handleCheck(eng.id)}>{t('engine.retry')}</Button>}
          </div>}
          {(startingLoginHere || activeLoginHere) && <div className="dchat-profile-form" style={{ fontSize: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <span role="status">{t(startingLoginHere ? 'engineSettings.startingLogin' : 'engineSettings.waitingLogin')}</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {activeLoginHere && loginJob.status === 'waiting_auth' && loginJob.authUrl && <a href={loginJob.authUrl} target="_blank" rel="noopener noreferrer"
                  style={{ color: 'var(--dsw-alias-state-business-primary)', textDecoration: 'underline' }}>
                  {t('engineSettings.openLoginPage')}
                </a>}
                {activeLoginHere && <Button variant="outline" size="sm" disabled={cancellingLogin || loginJob.status === 'finishing'}
                  onClick={() => void handleCancelLogin()}>{t('cancel')}</Button>}
              </div>
            </div>
            {activeLoginHere && awaitsCode(loginJob) && <form onSubmit={handleSubmitCode} className="dchat-login-code-form">
              <input type="text" autoComplete="off" spellCheck={false} className="dchat-profile-input"
                placeholder={t(eng.id === 'agy' ? 'engineSettings.agyPasteCode' : 'engineSettings.pasteCode')} value={loginCode}
                onChange={e => setLoginCode(e.target.value)} />
              <Button type="submit" variant="primary" size="sm" disabled={!loginCode.trim() || submittingCode || cancellingLogin}>
                {t('engineSettings.submitCode')}
              </Button>
            </form>}
          </div>}

          {isExpanded && <div className={focusedEngine ? 'dchat-profile-panel dchat-profile-panel--flat' : 'dchat-profile-panel'}>
            {focusedEngine && addForm}
            {repeatedGoogleAccount && <div className="dchat-archive-meta" style={{ padding: '6px 0' }}>{t('engineSettings.agySameAccount')}</div>}
            {profiles.map(prof => {
              const pKey = `${eng.id}:${prof.id}`
              const isDefault = prof.id === activeProfileId
              const isNamedProfile = ['config', 'env', 'isolated'].includes(prof.kind)
              const agyNative = isAgy && prof.kind === 'default'
              const displayName = agyNative ? t('engineSettings.agyNative') : isNamedProfile ? prof.name : (prof.account || prof.authLabel || prof.name)
              const secondaryAccount = (isNamedProfile || agyNative) && prof.account !== displayName &&
                prof.account !== 'Google OAuth' ? prof.account : undefined
              const isEditingThis = editingProfile?.engineId === eng.id && editingProfile?.prof?.id === prof.id
              return <div key={prof.id} className="dchat-profile-row" data-disabled={prof.disabled || undefined}>
                <div className="dchat-profile-main">
                  <div className="dchat-profile-info">
                    <div className="dchat-profile-title-row">
                      <strong>{displayName}</strong>
                      {isDefault && <span className="dchat-engine-pill">{t('engineSettings.defaultTag')}</span>}
                      {prof.disabled && <span className="dchat-engine-pill" data-tone="warn">{t('engineSettings.disabledTag')}</span>}
                      {prof.authenticated === false && <span className="dchat-engine-pill" data-tone="warn">
                        {prof.kind === 'snapshot' && eng.id === 'agy' ? t('engineSettings.readdOAuth') : prof.envKey ? t('engineSettings.missingKey', { key: prof.envKey }) : t('engine.notLoggedIn')}
                      </span>}
                    </div>
                    {(secondaryAccount || (isAgy && prof.kind === 'isolated')) && (
                      <div className="dchat-archive-meta">
                        {secondaryAccount && <span>{secondaryAccount}</span>}
                        {isAgy && prof.kind === 'isolated' && <span>{t('engineSettings.agyIsolated')}</span>}
                      </div>
                    )}
                  </div>
                  <div className="dchat-profile-actions">
                    {isNamedProfile && <Button variant="outline" size="sm"
                      onClick={() => isEditingThis ? setEditingProfile(null) : startEditProfile(eng.id, prof)}>
                      {t('engineSettings.edit')}
                    </Button>}
                    {isOAuthProfile(prof) && eng.canLogin && prof.authenticated !== true && <Button variant="primary" size="sm" disabled={loginBusy || loggingOutKey === pKey || s.installed === false}
                      onClick={() => void handleStartLogin(eng.id, { profileId: prof.id })}>
                      {t('engineSettings.login')}
                    </Button>}
                    {prof.authenticated === true && eng.canLogout && isOAuthProfile(prof) && <Button variant="outline" size="sm"
                      disabled={Boolean(loggingOutKey) || loginBusy} onClick={() => void handleLogout(eng.id, prof.id)}>
                      {t(loggingOutKey === pKey ? 'engineSettings.loggingOut' : logoutLabel(eng.id, prof))}
                    </Button>}
                    {!isDefault && !prof.disabled && (!isAgy || isOAuthProfile(prof)) && <Button variant="outline" size="sm"
                      onClick={() => void handleProfileAction(eng.id, { action: 'setDefault', profileId: prof.id })}>
                      {t('engineSettings.setDefault')}
                    </Button>}
                    {(!isAgy || isOAuthProfile(prof)) && <Button variant="outline" size="sm"
                      onClick={() => void handleProfileAction(eng.id, { action: 'setDisabled', profileId: prof.id, disabled: !prof.disabled })}>
                      {t(prof.disabled ? 'engineSettings.enable' : 'engineSettings.disable')}
                    </Button>}
                    {prof.id !== 'default' && prof.kind !== 'config' && <Button variant="outline" size="sm" className="dchat-profile-danger"
                      onClick={() => void handleProfileAction(eng.id, { action: 'delete', profileId: prof.id })}>
                      {t('engineSettings.deleteProfile')}
                    </Button>}
                  </div>
                </div>
                {isEditingThis && <div className="dchat-profile-form">
                  {prof.kind === 'isolated' ? <input type="text" className="dchat-profile-input" aria-label={t('engineSettings.profileName')} value={editName}
                    onChange={e => setEditName(e.target.value)} />
                  : prof.kind === 'env' ? <textarea rows={3} className="dchat-profile-input" placeholder={t('engineSettings.envVarHint')} value={editEnvText}
                    onChange={e => setEditEnvText(e.target.value)} style={{ fontFamily: 'monospace' }} />
                  : <>
                    {prof.envKey && <input type="password" className="dchat-profile-input" value={editKeyVal} onChange={e => setEditKeyVal(e.target.value)}
                      placeholder={prof.hasEnvKeyOverride ? t('engineSettings.apiKeySaved') : t('engineSettings.apiKey', { key: prof.envKey })} />}
                    <input type="text" className="dchat-profile-input" value={editBaseUrl} onChange={e => setEditBaseUrl(e.target.value)}
                      placeholder={prof.defaultBaseUrl || t('engineSettings.baseUrl')} />
                  </>}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Button variant="primary" size="sm" disabled={prof.kind === 'isolated' && !editName.trim()} onClick={() => void handleSaveEdit()}>{t('engineSettings.saveProfile')}</Button>
                    <Button variant="outline" size="sm" onClick={() => setEditingProfile(null)}>{t('cancel')}</Button>
                  </div>
                </div>}
              </div>
            })}
            {!focusedEngine && (addForm || <div className="dchat-profile-footer">
              {addButtons}
              {eng.canUpdate && !s.updateAvailable && <Button variant="outline" size="sm"
                disabled={isChecking || isUpdating} onClick={() => void handleUpdate(eng.id)}>
                {isUpdating ? t('engine.updating') : t('engineSettings.reinstall')}
              </Button>}
            </div>)}
          </div>}
        </li>
      })}
    </ul> : <p className="dchat-archive-empty" role="status">
      {status === 'loading' ? t('engine.loading') : t('engine.empty')}
    </p>}
  </section>
}
