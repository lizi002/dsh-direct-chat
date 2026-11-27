import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, focusWithoutRing, IconSlidersTwoOutlineRegular, IconBranchOutlineRegular, IconCheckOutlineRegular,
  IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular,
  IconCloseFillRegular, IconCloseOutlineRegular, IconCompactOutlineRegular, IconDataOutlineRegular,
  IconDownloadOutlineRegular, IconGoalOutlineRegular, IconPaperPlaneOutlineRegular, IconPlanOutlineRegular,
  IconNewChatOutlineRegular, IconPaperclipOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSendOutlineRegular,
  IconStopFillRegular, Input, isMobileDevice, MarkdownDelegateProvider, MarkdownText,
  IconUsersOutlineRegular, Menu, MenuGroup, MenuSurface, Modal, observeStickyMenuGroups,
  PermissionIconFullAccessRegular, rankByName, StateDot, TextShimmer, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { AttachmentRail } from '@deepseek-ai/dsh-client-ui-attachment/src/AttachmentRail.tsx'
import { TurnNavigator } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/TurnNavigator.tsx'
import { RunningStatus } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/RunningStatus.tsx'
import { ConversationWidthControls } from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/ConversationWidthControls.tsx'
import inputLayout from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/InputBar.module.css'
import conversationLayout from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/ConversationRoot.module.css'
import { TodoPanel } from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/TodoPanel.tsx'
import {
  accountChoiceLabel, applyEvent, attachmentIssue, composerAccount, configGroups, createSession, encodeAttachment, engineLabel, fileUriReference, getGitBranches, inlineFileReference,
  hasDraggedFiles, markdownFileReference, normalizeMarkdownFileUrls, openEvents, permissionId,
  projectActivity, promptDelivery, sessionAction,
} from './chat-state.mjs'
import { createWorktreePrompt } from './worktree-prompt.mjs'
import { WorktreeToggle } from './WorktreeToggle.jsx'
import { useComposerCommands } from './ComposerCommands.jsx'
import { commandEntries } from './composer-commands.mjs'
import { EngineDropdown, EngineLogo } from './EngineHero.jsx'
import { EngineSettings } from './EngineSettings.jsx'
import { ReviewCommand } from './ReviewCommand.jsx'
import { codexPromptCommand } from './review-command.mjs'
import { MessageQueue, pendingQueueSubmission } from './MessageQueue.jsx'
import { SessionStatus } from './SessionStatus.jsx'
import { SessionPet } from './SessionPet.jsx'
import { RunningJobsAction } from './RunningJobs.jsx'
import { TranscriptActivity, toolIcons } from './TranscriptActivity.jsx'
import { WorkspaceDiff } from './WorkspaceDiff.jsx'
import { appendReviewQuote } from './workspace-diff-view.mjs'
import { questionReply } from './codex-transcript.mjs'
import { WorkspacePicker } from './WorkspacePicker.jsx'
import { createTranscriptFollow, isNearTranscriptBottom, transcriptTurnItems } from './transcript-scroll.mjs'

const noAgents = []
const noTools = []
const nativeSyncEngines = new Set(['codex', 'agy', 'claude'])
const nativeSyncStatuses = new Set(['synced', 'current', 'busy', 'conflict', 'unavailable'])

const isBackgroundTool = tool => {
  if (!tool) return false
  if (tool.execution?.background || tool._meta?.background) return true
  const text = `${tool.execution?.output ?? ''}\n${tool.execution?.outputTail ?? ''}\n${tool.execution?.stdout ?? ''}`
  return /running as a background task|background task with task id:/i.test(text)
}

const isActiveTool = tool => tool?.status === 'pending' || tool?.status === 'in_progress'
const defaultSubmissionSettings = { getSnapshot: () => undefined, subscribe: () => () => {} }
const INITIAL_VISIBLE_MESSAGES = 24
const LOAD_MORE_MESSAGES_STEP = 32
const commandIcons = new Map([
  ['compact', IconCompactOutlineRegular],
  ['permission', PermissionIconFullAccessRegular],
  ['model', IconDataOutlineRegular],
  ['goal', IconGoalOutlineRegular],
  ['plan', IconPlanOutlineRegular],
  ['feedback', IconPaperPlaneOutlineRegular],
  ['export', IconDownloadOutlineRegular],
])

const RIGHTBAR_MIN = 300
const RIGHTBAR_DEFAULT_RATIO = 0.45
const RIGHTBAR_MAX_RATIO = 0.7
const RIGHTBAR_CENTER_MIN = 360
const RIGHTBAR_WIDTH_KEY = 'dsh-direct-chat.rightbar-width'

function clampRightbarWidth(width, maxWidth = 1200) {
  return Math.min(maxWidth, Math.max(RIGHTBAR_MIN, Math.round(width)))
}

function readSavedRightbarWidth() {
  try {
    const raw = Number(localStorage.getItem(RIGHTBAR_WIDTH_KEY))
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null
  } catch {
    return null
  }
}

const noopRightbarLayout = { openRightbar() {}, closeRightbar() {} }

export function DirectChat({ navigation, startNative, renderFactorySlot, useContextMenu, workspaceSource, engineSource, diffController, renderRightbar, performanceSettings, submissionSettings, queueDock, statusStore, nativeSessions, useSessionStatus, useWorkspaces, openDirect, openNative, t }) {
  const target = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot)
  const { engines, status: engineStatus } = useSyncExternalStore(engineSource.subscribe, engineSource.getSnapshot)
  const diffState = useSyncExternalStore(
    diffController?.subscribe ?? defaultSubmissionSettings.subscribe,
    diffController?.getSnapshot ?? (() => ({ open: false })),
  )
  const [column, setColumn] = useState(null)
  const [metadata, setMetadata] = useState(null)
  const parent = useRef(null)
  const [agentSummary, setAgentSummary] = useState(null)
  const [runtimeSummary, setRuntimeSummary] = useState(null)
  const shellRef = useRef(null)
  const [shellWidth, setShellWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 1200)
  const [rightbarWidth, setRightbarWidth] = useState(readSavedRightbarWidth)
  const [draggingSplit, setDraggingSplit] = useState(false)
  const dragOriginRef = useRef(null)
  const latestRightbarWidthRef = useRef(rightbarWidth)

  useLayoutEffect(() => {
    const node = shellRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const next = node.getBoundingClientRect().width
      if (next > 0) setShellWidth(next)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : shellWidth
  const canShowSplit = Boolean(renderRightbar) && viewportWidth >= 768 && shellWidth >= 760
  const maxSplitWidth = Math.max(
    RIGHTBAR_MIN,
    Math.min(Math.floor(viewportWidth * RIGHTBAR_MAX_RATIO), shellWidth - RIGHTBAR_CENTER_MIN),
  )
  const preferredRightbarWidth = rightbarWidth ?? Math.round(viewportWidth * RIGHTBAR_DEFAULT_RATIO)
  const resolvedRightbarWidth = clampRightbarWidth(preferredRightbarWidth, maxSplitWidth)
  latestRightbarWidthRef.current = resolvedRightbarWidth

  useLayoutEffect(() => {
    if (!diffController) return
    diffController.useLayoutSeat(canShowSplit)
    return () => diffController.useLayoutSeat(false)
  }, [diffController, canShowSplit])

  const startSplitDrag = event => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragOriginRef.current = { x: event.clientX, width: resolvedRightbarWidth }
    setDraggingSplit(true)
  }
  const moveSplitDrag = event => {
    if (!dragOriginRef.current) return
    const next = clampRightbarWidth(dragOriginRef.current.width + (dragOriginRef.current.x - event.clientX), maxSplitWidth)
    latestRightbarWidthRef.current = next
    setRightbarWidth(next)
  }
  const endSplitDrag = () => {
    if (!dragOriginRef.current) return
    dragOriginRef.current = null
    setDraggingSplit(false)
    try { localStorage.setItem(RIGHTBAR_WIDTH_KEY, String(latestRightbarWidthRef.current)) } catch {}
  }

  const current = metadata?.id === target.id ? metadata : null
  const currentAgents = agentSummary?.id === target.id ? agentSummary : null
  const currentRuntime = runtimeSummary?.id === target.id ? runtimeSummary : null
  const engine = engineStatus === 'ready' && !engines.some(item => item.id === target.engine && item.status?.installed !== false)
    ? undefined : target.engine
  const engineMeta = engines.find(item => item.id === engine)?.meta
  const showSplitPane = canShowSplit && Boolean(diffState?.open)

  return <div ref={shellRef} className="dchat-shell" data-dragging-split={draggingSplit || undefined}>
    <section className="dchat" data-blank={!target.id || undefined} data-hero-engine={!target.id ? engine : undefined}
      style={!target.id && engineMeta?.accentColor ? { '--dchat-hero-accent': engineMeta.accentColor } : undefined} aria-label={t('panel')}>
      <header className="dchat-header">
        <div className="dchat-title">
          {target.id && <>
            {current?.parentId && <Button size="sm" className="dchat-parent" aria-label={t('parallel.parent')}
              title={t('parallel.parent')} onClick={() => navigation.open(current.parentId)}>
              <IconChevronLeftOutlineRegular size={16} />
              <span>{parent.current?.id === current.parentId ? parent.current.title : t('agents.parent')}</span>
            </Button>}
            <h1 title={current?.title}>{current?.title || t('panel')}</h1>
            {current && (() => {
              const engInfo = engines.find(item => item.id === current.engine)
              const engStatus = engInfo?.status
              return <span className="dchat-engine-label" title={current.cwd}>
                <EngineLogo engine={current.engine} size={14} />{engineLabel(engines, current.engine)}
                {engStatus?.version && <span className="dchat-engine-version">v{engStatus.version}</span>}
                {engStatus?.updateAvailable && <span className="dchat-engine-pill" data-tone="update">
                  {t('engine.updateAvailable', { version: engStatus.latestVersion })}
                </span>}
              </span>
            })()}
            <SubagentCatalog key={target.id} summary={currentAgents} openChild={id => {
              parent.current = current
              navigation.open(id)
            }} t={t} />
          </>}
        </div>
        <div className="dchat-header-actions">
          {target.id && nativeSyncEngines.has(current?.engine ?? target.engine) && <NativeSyncAction
            key={`native-sync-${target.id}`} id={target.id} summary={currentRuntime} refreshHistory={navigation.refreshHistory} t={t} />}
          {target.id && <RunningJobsAction key={target.id} sessionId={target.id} summary={currentRuntime} t={t} />}
          {diffController && <WorkspaceDiff controller={diffController} t={t} />}
          {statusStore && <SessionPet variant="header" statusStore={statusStore} nativeSessions={nativeSessions}
            useSessionStatus={useSessionStatus} useWorkspaces={useWorkspaces}
            engineSource={engineSource} openDirect={openDirect || (sessionId => navigation.open(sessionId))} openNative={openNative} t={t} />}
        </div>
      </header>
      <div ref={setColumn} className={conversationLayout.body}>
        <div className={conversationLayout.scrollBody}>
          <SessionPane key={target.key ?? target.id ?? target.engine} target={target} navigation={navigation} startNative={startNative} performanceSettings={performanceSettings} submissionSettings={submissionSettings}
            engine={engine} engines={engines} engineStatus={engineStatus} engineSource={engineSource} reloadEngines={engineSource.refresh} diffController={diffController}
            queueDock={queueDock} onAgentSummary={setAgentSummary} onRuntimeSummary={setRuntimeSummary} onSession={setMetadata}
            renderFactorySlot={renderFactorySlot} workspaceSource={workspaceSource} t={t} />
        </div>
        <ConversationWidthControls container={column} phase={target.id ? 'active' : 'hero'} />
      </div>
    </section>
    {showSplitPane && <>
      <div className="dchat-split-handle" role="separator" aria-orientation="vertical"
        onPointerDown={startSplitDrag} onPointerMove={moveSplitDrag} onPointerUp={endSplitDrag} onPointerCancel={endSplitDrag} />
      <aside className="dchat-split-rightbar" style={{ width: `${resolvedRightbarWidth}px` }}>
        {renderRightbar({ useContextMenu, width: resolvedRightbarWidth, viewportWidth, canShow: true, layout: noopRightbarLayout })}
      </aside>
    </>}
  </div>
}

function NativeSyncAction({ id, summary, refreshHistory, t }) {
  const [syncing, setSyncing] = useState(false)
  const [notice, setNotice] = useState(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const request = useRef(false)
  const noticeSequence = useRef(0)
  const conflict = summary?.nativeConflict || notice?.status === 'conflict'
  const busy = summary?.busy || summary?.pending
  const disabled = syncing || (!conflict && (!summary?.ready || busy))
  const label = t(syncing ? 'nativeSync.syncing' : conflict ? 'nativeSync.view' : busy ? 'nativeSync.busy' : 'nativeSync.action')

  const activate = async () => {
    if (disabled || request.current) return
    if (conflict) {
      setPreviewOpen(true)
      return
    }
    request.current = true
    setSyncing(true)
    setNotice(null)
    let status = 'failed'
    try {
      const result = await sessionAction(id, 'sync-native', {})
      if (nativeSyncStatuses.has(result?.status)) status = result.status
    } catch {}
    request.current = false
    setSyncing(false)
    setNotice({ status, sequence: ++noticeSequence.current })
    if (status === 'synced') void refreshHistory?.()
  }

  return <>
    <Tooltip label={label} side="bottom" align="end" portal>
      <Button className="dchat-native-sync" size="sm" aria-label={label} aria-disabled={disabled || undefined}
        aria-haspopup={conflict ? 'dialog' : undefined} aria-busy={syncing || undefined} onClick={activate}>
        {syncing ? <StateDot state="ongoing" /> : conflict
          ? <IconBranchOutlineRegular size={16} />
          : <IconRefreshOutlineRegular size={16} />}
      </Button>
    </Tooltip>
    {notice && <Toast key={notice.sequence} text={t(`nativeSync.${notice.status}`)}
      tone={['synced', 'current'].includes(notice.status) ? 'success' : undefined} onDone={() => setNotice(null)} />}
    {previewOpen && <NativeHistoryPreview id={id} close={() => setPreviewOpen(false)} t={t} />}
  </>
}

function NativeHistoryPreview({ id, close, t }) {
  const [messages, setMessages] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    sessionAction(id, 'native-preview', {}).then(result => {
      if (!active) return
      if (Array.isArray(result?.messages)) {
        setMessages(result.messages.filter(message => message?.role === 'user' || message?.role === 'assistant'))
      } else {
        setFailed(true)
      }
    }, () => { if (active) setFailed(true) })
    return () => { active = false }
  }, [id])

  return <Modal open title={t('nativeSync.previewTitle')} description={t('nativeSync.previewDescription')}
    closeLabel={t('close')} onClose={close} className="dchat-native-preview"
    footer={<Button variant="outline" data-modal-autofocus onClick={close}>{t('close')}</Button>}>
    {failed ? <p className="dchat-error" role="alert">{t('nativeSync.previewFailed')}</p>
      : messages === null ? <p className="dchat-status" role="status">{t('nativeSync.previewLoading')}</p>
      : !messages.length ? <p className="dchat-status" role="status">{t('nativeSync.previewEmpty')}</p>
      : <div className="dchat-native-preview-transcript" tabIndex={0} aria-label={t('transcript')}>
        {messages.map((message, index) => <NativePreviewMessage key={index} message={message} t={t} />)}
      </div>}
  </Modal>
}

function NativePreviewMessage({ message, t }) {
  const { text, role, thought, tools } = message
  return <article className="dchat-native-preview-message" aria-label={t(role === 'user' ? 'you' : 'nativeSync.assistant')}>
    <h3>{t(role === 'user' ? 'you' : 'nativeSync.assistant')}</h3>
    {typeof thought === 'string' && thought && <details>
      <summary>{t('thought')}</summary>
      <p>{thought}</p>
    </details>}
    {Array.isArray(tools) && tools.length > 0 && <details>
      <summary>{t('nativeSync.tools', { count: tools.length })}</summary>
      <ul>{tools.map((tool, index) => <li key={index}>
        {t(Object.hasOwn(toolIcons, tool?.kind) ? `activity.${tool.kind}` : 'permission.tool')}
        {['pending', 'in_progress', 'completed', 'failed'].includes(tool?.status) && ` · ${t(tool.status)}`}
      </li>)}</ul>
    </details>}
    {typeof text === 'string' && text && <p>{text}</p>}
  </article>
}

function SessionPane({ queueDock, onAgentSummary, onRuntimeSummary, target, navigation, startNative, performanceSettings, submissionSettings = defaultSubmissionSettings, onSession, renderFactorySlot, workspaceSource, engine, engines, engineStatus, engineSource, reloadEngines, diffController, t }) {
  const blank = !target.id
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false)
  const cwd = target.cwd ?? ''
  const [draftProfiles, setDraftProfiles] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem('dsh-direct-chat.draft-profiles') ?? 'null')
      return saved && typeof saved === 'object' ? saved : {}
    } catch { return {} }
  })
  const selectDraftProfile = (targetEngine, profileId) => {
    setDraftProfiles(prev => {
      const next = { ...prev, [targetEngine]: profileId }
      try { sessionStorage.setItem('dsh-direct-chat.draft-profiles', JSON.stringify(next)) } catch {}
      return next
    })
  }
  const profileId = engine && typeof draftProfiles[engine] === 'string' ? draftProfiles[engine] : undefined
  const [prepared, setPrepared] = useState(null)
  const [prepareAttempt, setPrepareAttempt] = useState(0)
  const [gitBranches, setGitBranches] = useState(null)
  const [worktreeDraft, setWorktreeDraft] = useState({ cwd: '', enabled: false, from: undefined })
  const gitInfo = gitBranches?.cwd === cwd ? gitBranches.info : null
  const worktreeEnabled = worktreeDraft.cwd === cwd && worktreeDraft.enabled
  const worktreeFrom = worktreeDraft.cwd === cwd ? worktreeDraft.from : undefined
  const worktreeBase = worktreeFrom === undefined ? gitInfo?.current : worktreeFrom
  const sendWorktree = useMemo(() => createWorktreePrompt(cwd, worktreeBase), [cwd, worktreeBase])
  const preparation = prepared?.engine === engine && prepared?.cwd === cwd && prepared.profileId === profileId && prepared.attempt === prepareAttempt ? prepared : null
  const id = target.id ?? preparation?.session?.id
  const [feed, setFeed] = useState(null)
  const session = feed?.id === id ? feed : preparation?.session ?? null
  const [stream, setStream] = useState(null)
  const connection = stream && stream.id === id ? stream.phase : 'connecting'
  const [connectAttempt, setConnectAttempt] = useState(0)
  const composer = navigation.draftFor(target, engine)
  const { text: draft, command: stagedCommand, attachments, sending, error: sendError } =
    useSyncExternalStore(composer.subscribe, composer.getSnapshot)
  const { setText: setDraft, setCommand: setStagedCommand, setAttachments } = composer
  const [draggingFiles, setDraggingFiles] = useState(false)
  const fileDragDepth = useRef(0)
  const [error, setError] = useState('')
  const [invalidEvent, setInvalidEvent] = useState(false)
  const [pendingAction, setPending] = useState(null)
  const pending = sending ? 'prompt' : pendingAction
  const [queueEcho, setQueueEcho] = useState(null)
  const [deliveryMenuOpen, setDeliveryMenuOpen] = useState(false)
  const subscribeSubmission = useCallback(listener => submissionSettings.subscribe(listener), [submissionSettings])
  const readSubmission = useCallback(() => submissionSettings.getSnapshot()?.value?.busyEnter, [submissionSettings])
  const busyEnter = useSyncExternalStore(subscribeSubmission, readSubmission, readSubmission)
  const [mobileOptionsOpen, setMobileOptionsOpen] = useState(false)
  const optionsRowId = useId()
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [parallelOpen, setParallelOpen] = useState(false)
  const [visibleWindow, setVisibleWindow] = useState({ id: null, count: INITIAL_VISIBLE_MESSAGES })
  const [followingTail, setFollowingTail] = useState(true)
  const [follow] = useState(() => createTranscriptFollow(setFollowingTail))
  const [activeTurn, setActiveTurn] = useState(null)
  const [expandedTools, setExpandedTools] = useState({ id: null, tools: new Set() })
  const pendingTurnJumpRef = useRef(null)
  const scrollAnchorRef = useRef(null)
  const lastScrollTopRef = useRef(0)
  const scrollRafRef = useRef(0)
  const modelTriggerRef = useRef(null)
  const [commandDialog, setCommandDialog] = useState(null)
  const transcript = useRef(null)
  const transcriptContent = useRef(null)
  const input = useRef(null)
  const fileInput = useRef(null)
  const reviewInput = useRef(null)
  const focusReviewInput = useRef(false)
  const nextAttachment = useRef(Math.max(-1,...attachments.map(item => item.id)) + 1)
  const diffId = blank && !cwd ? undefined : id
  const diffCwd = diffId ? session?.cwd || (blank ? cwd : undefined) : undefined

  reviewInput.current = format => {
    if (!input.current || pending === 'prompt' || stagedCommand || draft.trimStart().startsWith('/')) return false
    focusReviewInput.current = true
    setDraft(current => appendReviewQuote(current, format))
    return true
  }
  useLayoutEffect(() => {
    if (!focusReviewInput.current) return
    focusReviewInput.current = false
    input.current?.focus({ preventScroll: true })
    input.current?.setSelectionRange(draft.length, draft.length)
  }, [draft])
  useLayoutEffect(() => diffController?.bindTarget(diffId && diffCwd ? {
    id: diffId, cwd: diffCwd, addReviewToInput: format => reviewInput.current(format),
  } : null),
    [diffController, diffId, diffCwd])

  useEffect(() => {
    if (!blank || !cwd) {
      setGitBranches(null)
      return
    }
    const controller = new AbortController()
    getGitBranches(cwd, controller.signal).then(info => {
      if (!controller.signal.aborted) setGitBranches({ cwd, info })
    }).catch(() => {
      if (!controller.signal.aborted) setGitBranches({ cwd, info: null })
    })
    return () => controller.abort()
  }, [blank, cwd])

  const refreshGitBranches = useCallback(async () => {
    if (!cwd) return
    try {
      const info = await getGitBranches(cwd)
      setGitBranches({ cwd, info })
    } catch {}
  }, [cwd])

  useEffect(() => {
    if (!blank || !engine) return
    let current = true
    createSession(engine, cwd, profileId).then(session => {
      if (current) setPrepared({ engine, profileId, cwd, attempt: prepareAttempt, session })
    }, error => {
      if (current) setPrepared({ engine, profileId, cwd, attempt: prepareAttempt, error: error.message })
    })
    return () => { current = false }
  }, [blank, engine, cwd, profileId, prepareAttempt])

  useEffect(() => {
    if (!id) return
    setStream({ id, phase: 'connecting' })
    const source = openEvents(id)
    source.onerror = () => setStream({ id, phase: 'disconnected' })
    source.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data)
        if (event.type === 'snapshot') {
          const { engine, cwd, title, parentId } = event.data
          onSession({ id, engine, cwd, title, parentId })
          setStream({ id, phase: 'ready' })
          setInvalidEvent(false)
        }
        setFeed(previous => applyEvent(previous?.id === id ? previous : null, event))
        if (event.type === 'done' || event.type === 'error') void navigation.refreshHistory?.()
      } catch {
        setInvalidEvent(true)
      }
    }
    return () => source.close()
  }, [id, connectAttempt, onSession, navigation])

  useLayoutEffect(() => {
    follow.setFollowing(true)
    lastScrollTopRef.current = 0
    scrollAnchorRef.current = null
    pendingTurnJumpRef.current = null
    setActiveTurn(null)
    return () => {
      follow.cancelSample()
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = 0
    }
  }, [follow, id])

  useLayoutEffect(() => {
    const node = transcript.current
    if (!node || blank) return
    const settle = () => follow.settle(node)
    node.addEventListener('scrollend', settle)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      if (follow.following && !follow.pending) lastScrollTopRef.current = follow.toBottom(node)
    }) : null
    observer?.observe(node)
    if (transcriptContent.current) observer?.observe(transcriptContent.current)
    return () => {
      observer?.disconnect()
      node.removeEventListener('scrollend', settle)
    }
  }, [blank, follow, id])

  useLayoutEffect(() => {
    const node = transcript.current
    if (!node || blank) return
    if (pendingTurnJumpRef.current !== null) {
      const targetIdx = pendingTurnJumpRef.current
      const el = node.querySelector(`[data-message-index="${targetIdx}"]`)
      if (el) {
        pendingTurnJumpRef.current = null
        scrollAnchorRef.current = null
        const top = Math.max(0, node.scrollTop + el.getBoundingClientRect().top - node.getBoundingClientRect().top - 16)
        node.scrollTop = top
        lastScrollTopRef.current = node.scrollTop
        follow.setFollowing(isNearTranscriptBottom(node))
        return
      }
    }
    if (scrollAnchorRef.current) {
      const { prevHeight, prevTop } = scrollAnchorRef.current
      scrollAnchorRef.current = null
      const nextTop = Math.max(0, prevTop + (node.scrollHeight - prevHeight))
      node.scrollTop = nextTop
      lastScrollTopRef.current = node.scrollTop
      return
    }
    if (follow.following && !follow.pending) lastScrollTopRef.current = follow.toBottom(node)
  }, [blank, follow, id, session, visibleWindow])

  const perform = async (action, data, onError = setError) => {
    if (!id || pending || connection !== 'ready') return false
    setPending(action)
    setError('')
    try {
      await sessionAction(id, action, typeof data === 'function' ? await data() : data)
      return true
    } catch (error) {
      const translated = error.code ? t(error.code) : ''
      onError(translated && translated !== error.code ? translated : error.message || t('request.failed'))
      return false
    } finally {
      setPending(null)
    }
  }

  const busy = Boolean(session?.busy)
  const [fallbackStartedAt, setFallbackStartedAt] = useState(undefined)
  useEffect(() => {
    setFallbackStartedAt(busy && !session?.runStartedAt ? Date.now() : undefined)
  }, [busy, session?.runStartedAt, id])
  const runStartedAt = busy ? (session?.runStartedAt ?? fallbackStartedAt) : undefined
  const ready = connection === 'ready'
  const capabilities = session?.capabilities ?? {}
  const currentEngine = session?.engine ?? (blank ? engine : undefined)
  const engineInfo = engines.find(item => item.id === currentEngine)
  const displayedAccount = composerAccount(session?.account, engineInfo, blank && engine, profileId)
  const currentCapabilities = engineInfo?.capabilities
  const readOnly = capabilities.readOnly === true
  const needsEngine = blank && !engine
  const commandKey = stagedCommand && `cmd.${stagedCommand}`
  const commandTitle = commandKey && t(commandKey)
  const stagedTitle = commandTitle === commandKey ? null : commandTitle
  const hasDraft = Boolean(draft.trim()) || attachments.length > 0 || Boolean(stagedCommand)
  const canSendPrompt = ready && !pending && hasDraft
  const canSteer = busy && capabilities.steer === true
  const canSteerDraft = canSteer && !stagedCommand && !attachments.length && !draft.trimStart().startsWith('/')
  const queue = session?.queue ?? noAgents
  const canSteerQueue = ready && !pending && !hasDraft && canSteer && queue.length > 0
  const deliveryFor = alternate => promptDelivery(busy, canSteerDraft, busyEnter, alternate, queue.length > 0)
  const primaryDelivery = deliveryFor(false)
  const sendLabel = t(primaryDelivery ? `send.${primaryDelivery}` : 'send')
  useEffect(() => { if (!canSteerDraft || !hasDraft) setDeliveryMenuOpen(false) }, [canSteerDraft, hasDraft])
  const stage = files => {
    if (!files.length || pending === 'prompt') return
    const issue = attachmentIssue([...attachments.map(item => item.file), ...files])
    if (issue) { setError(t(issue)); return }
    setError('')
    setAttachments([...attachments, ...files.map(file => ({ id: nextAttachment.current++, file }))])
  }
  const submitPrompt = async data => {
    const settle = composer.beginSend()
    if (!settle) return
    follow.setFollowing(true)
    let failure = ''
    if (blank && worktreeEnabled && gitInfo?.isGit && gitInfo.commit) {
      setPending('prompt')
      setError('')
      try {
        const payload = typeof data === 'function' ? await data() : data
        await sendWorktree({ engine, profileId, options: configOptions, payload, navigation, target })
        settle(true, '')
        const editor = input.current
        if (editor?.form && editor.ownerDocument.activeElement === editor && isMobileDevice()) {
          focusWithoutRing(editor.form, { preventScroll: true })
        }
        setWorktreeDraft({ cwd: '', enabled: false, from: undefined })
        return
      } catch (err) {
        const translated = err?.code ? t(err.code) : ''
        failure = translated && translated !== err?.code ? translated : err?.message || t('request.failed')
        setError(failure)
        settle(false, failure)
        return
      } finally {
        setPending(null)
      }
    }
    const sent = await perform('prompt', data, message => { failure = message })
    settle(sent, failure)
    if (sent) {
      const editor = input.current
      if (editor?.form && editor.ownerDocument.activeElement === editor && isMobileDevice()) {
        focusWithoutRing(editor.form, { preventScroll: true })
      }
      if (blank) navigation.open(id, target)
      else navigation.refreshHistory?.()
    }
  }
  const executeImmediateCommand = async commandText => {
    if (!ready || busy || pending) return
    if (attachments.length) { setError(t('composer.commandNoAttachments')); return }
    if (!stagedCommand && commandText.startsWith(draft.trim().toLowerCase())) setDraft(commandText)
    await submitPrompt({ text: commandText })
  }
  const send = async (delivery = primaryDelivery) => {
    if (!canSendPrompt) return
    const effectiveText = stagedCommand
      ? `/${stagedCommand}${draft.trim() ? ` ${draft.trim()}` : ''}`
      : (draft.trim() ? draft : '')
    const promptCommand = codexPromptCommand(effectiveText)
    const hasCommandDialog = currentCapabilities?.commandDialogs?.includes(promptCommand)
    if (hasCommandDialog && promptCommand === 'review' && effectiveText.trim() === '/review') {
      if (entries.some(entry => entry.name === 'review')) setCommandDialog('review')
      else setError(t('composer.reviewUnavailable'))
      return
    }
    const isCompactCommand = promptCommand === 'compact' && entries.some(entry => entry.name === 'compact')
    if ((hasCommandDialog || isCompactCommand) && attachments.length) {
      setError(t('composer.commandNoAttachments'))
      return
    }
    const files = attachments.map(item => item.file)
    const echo = delivery === 'queue' ? pendingQueueSubmission(effectiveText, files, capabilities) : null
    if (echo) setQueueEcho(echo)
    await submitPrompt(async () => {
      const payload = { text: effectiveText, delivery, clientRequestId: echo?.requestId }
      if (!files.length) return payload
      const issue = attachmentIssue(files)
      if (issue) throw new Error(t(issue))
      return { ...payload, attachments: await Promise.all(files.map(file => encodeAttachment(file, capabilities))) }
    })
    if (echo) {
      setQueueEcho(null)
      for (const file of echo.attachments) if (file.type === 'image') URL.revokeObjectURL(file.value.previewUrl)
    }
  }

  const activity = useMemo(() => projectActivity(session?.updates ?? []), [session?.updates])
  const hasLiveActivity = activity.steps.length > 0
  const toggleExecution = useCallback(toolId => setExpandedTools(previous => {
    const tools = new Set(previous.id === id ? previous.tools : undefined)
    if (tools.has(toolId)) tools.delete(toolId)
    else tools.add(toolId)
    return { id, tools }
  }), [id])
  const activeExpandedTools = expandedTools.id === id ? expandedTools.tools : undefined
  const footnotes = t('footnotes')
  const copyLabel = t('copy')
  const copiedLabel = t('copied')
  const markdownLabels = useMemo(() => ({ footnotes, code: { copyLabel, copiedLabel } }), [footnotes, copyLabel, copiedLabel])
  const openFile = useCallback((path, { line } = {}) => {
    if (id && typeof path === 'string' && path) diffController.openFile(id, { path, line })
  }, [diffController, id])
  const openMarkdownFile = useCallback((path, { line } = {}) => {
    const location = markdownFileReference(path, line)
    openFile(location.path, location)
  }, [openFile])
  const openMarkdownExternalLink = useCallback(href => {
    const file = fileUriReference(href)
    if (file) {
      openFile(file.path, { line: file.line })
      return
    }
    window.open(href, '_blank', 'noopener,noreferrer')
  }, [openFile])
  const fileMentions = useMemo(() => ({
    resolve(value) {
      const file = inlineFileReference(value)
      if (!file) return
      return { open: () => openFile(file.path, { line: file.line }), label: t('file.open', { path: value }), title: value }
    },
  }), [openFile, t])
  const reasoningMarkdown = useMemo(() => ({ labels: markdownLabels, fileMentions }), [markdownLabels, fileMentions])
  const connectionError = preparation?.error || (connection === 'disconnected' ? t('disconnected') : '')
  const configOptions = useMemo(() =>
    Array.isArray(session?.options) ? session.options.filter(item => item?.type === 'select' && configGroups(item).length > 0) : [],
  [session?.options])
  const model = configOptions.find(option => option.category === 'model')
  const effort = configOptions.find(option => option.category === 'thought_level')
  const otherOptions = configOptions.filter(option => option !== model && option !== effort)
  const changeConfig = (id, value) => perform('configure', { id, value })
  const configDisabled = !ready || busy || Boolean(pending)
  const canStartParallel = !blank && capabilities.parallel === true
  const commands = session?.updates?.some(item => item.update?.sessionUpdate === 'available_commands_update')
    ? activity.commands : projectActivity(preparation?.session?.updates ?? []).commands
  const entries = commandEntries(commands)
  const modeOption = otherOptions.find(option => option.category === 'mode')
  const teamCommands = ['teamwork', 'swarm'].map(name => entries.find(command => command.name === name)).filter(Boolean)
  const addItems = [
    ...(!needsEngine && !readOnly ? [{
      id: 'ui:attachment', name: 'file', title: t('plus.file'), icon: IconPaperclipOutlineRegular,
      onSelect: () => fileInput.current?.click(),
    }] : []),
    ...(canStartParallel ? [{
      id: 'ui:parallel', name: 'parallel', title: t('parallel.title'), icon: IconBranchOutlineRegular,
      onSelect: () => setParallelOpen(true),
    }] : []),
  ]
  const localizeCommand = entry => {
    const key = `cmd.${entry.name}`
    const translated = t(key)
    return { ...entry, title: translated && translated !== key ? translated : undefined, icon: commandIcons.get(entry.name) }
  }
  const pickerEntries = [
    ...(modeOption ? [{
      id: 'ui:permission', name: 'permission', label: '/permission', title: t('cmd.permission'),
      icon: PermissionIconFullAccessRegular, description: modeOption.name, onSelect: () => { setMobileOptionsOpen(true); setModeMenuOpen(true) },
    }] : []),
    ...(model ? [{
      id: 'ui:model', name: 'model', label: '/model', title: t('cmd.model'),
      icon: IconDataOutlineRegular, description: t('plus.model'), onSelect: () => modelTriggerRef.current?.click(),
    }] : []),
    ...entries.map(localizeCommand),
  ]
  const chooseNative = (entry, remainingDraft = draft) => {
    if (entry.name === 'mcp') {
      if (remainingDraft !== draft) setDraft(remainingDraft)
      input.current?.focus({ preventScroll: true })
      setCommandDialog('mcp')
      return true
    }
    if (entry.name === 'compact') {
      const text = remainingDraft.trim()
      if (!text || '/compact'.startsWith(text.toLowerCase())) {
        void executeImmediateCommand('/compact')
      } else {
        input.current?.focus({ preventScroll: true })
        setCommandDialog('compact')
      }
      return true
    }
    if (entry.name === 'review' && currentCapabilities?.commandDialogs?.includes('review')) {
      if (remainingDraft !== draft) setDraft(remainingDraft)
      input.current?.focus({ preventScroll: true })
      setCommandDialog('review')
      return true
    }
    setStagedCommand(entry.name)
    if (remainingDraft !== draft) setDraft(remainingDraft)
    input.current?.focus({ preventScroll: true })
    return true
  }
  const commandPicker = useComposerCommands({ input, draft, onDraft: setDraft, onNativeChoice: chooseNative,
    entries: pickerEntries, addItems, sessionId: id, disabled: readOnly || needsEngine || pending === 'prompt', t })
  const agents = session?.agents ?? noAgents
  const allMessages = session?.messages ?? noAgents
  const visibleCount = visibleWindow.id === id ? visibleWindow.count : INITIAL_VISIBLE_MESSAGES
  const hiddenMessageCount = Math.max(0, allMessages.length - visibleCount)
  const visibleMessages = hiddenMessageCount > 0 ? allMessages.slice(hiddenMessageCount) : allMessages
  const turnItems = useMemo(() => transcriptTurnItems(allMessages, hiddenMessageCount), [allMessages, hiddenMessageCount])

  const jumpToTurn = useCallback(item => {
    const node = transcript.current
    if (!node) return
    const messageIndex = item.anchor.kind === 'loaded' ? Number(item.anchor.key) : item.anchor.seq
    follow.setFollowing(false)
    setActiveTurn(item.turn)
    const el = node.querySelector(`[data-message-index="${messageIndex}"]`)
    if (el) {
      const top = Math.max(0, node.scrollTop + el.getBoundingClientRect().top - node.getBoundingClientRect().top - 16)
      node.scrollTop = top
      lastScrollTopRef.current = node.scrollTop
      follow.setFollowing(isNearTranscriptBottom(node))
      return
    }
    pendingTurnJumpRef.current = messageIndex
    const neededCount = allMessages.length - messageIndex + 4
    setVisibleWindow({ id, count: Math.min(allMessages.length, Math.max(visibleCount, neededCount)) })
  }, [allMessages.length, follow, id, visibleCount])

  const returnToBottom = useCallback(() => {
    const node = transcript.current
    if (!node) return
    pendingTurnJumpRef.current = null
    scrollAnchorRef.current = null
    lastScrollTopRef.current = follow.toBottom(node)
    if (turnItems.length) setActiveTurn(turnItems.at(-1).turn)
  }, [follow, turnItems])

  const loadEarlierMessages = useCallback(() => {
    if (hiddenMessageCount <= 0 || scrollAnchorRef.current || pendingTurnJumpRef.current !== null) return
    const node = transcript.current
    if (node) {
      scrollAnchorRef.current = { prevHeight: node.scrollHeight, prevTop: node.scrollTop }
    }
    setVisibleWindow(current => {
      const base = current.id === id ? current.count : INITIAL_VISIBLE_MESSAGES
      return { id, count: Math.min(allMessages.length, base + LOAD_MORE_MESSAGES_STEP) }
    })
  }, [hiddenMessageCount, id, allMessages.length])

  const seenLiveToolsRef = useRef(new Set())
  const runtimeTools = useMemo(() => {
    const byId = new Map()
    for (const tool of activity.tools) {
      const idKey = tool.toolCallId ?? `live-${byId.size}`
      if (isActiveTool(tool) && (tool.kind === 'execute' || tool.execution)) {
        seenLiveToolsRef.current.add(idKey)
      }
      if (isBackgroundTool(tool) || seenLiveToolsRef.current.has(idKey)) {
        byId.set(idKey, tool)
      }
    }
    for (const msg of session?.messages ?? noTools) {
      for (const tool of msg?.tools ?? noTools) {
        const idKey = tool?.toolCallId
        if (idKey && (isBackgroundTool(tool) || seenLiveToolsRef.current.has(idKey)) && !byId.has(idKey)) {
          byId.set(idKey, tool)
        }
      }
    }
    return byId.size ? [...byId.values()] : noTools
  }, [session?.messages, activity.tools])
  const performRef = useRef(perform)
  performRef.current = perform
  const stopCurrentTurn = useCallback(() => { void performRef.current('cancel') }, [])
  const nativeConflict = session?.nativeConflict === true

  useEffect(() => {
    if (!blank && id) onAgentSummary({ id, agents, ready, error: connectionError })
  }, [blank, id, agents, ready, connectionError, onAgentSummary])

  useEffect(() => {
    if (!blank && id && onRuntimeSummary) {
      onRuntimeSummary({
        id,
        tools: runtimeTools,
        ready,
        busy,
        pending,
        nativeConflict,
        stop: busy && ready && !pending ? stopCurrentTurn : null,
      })
    }
  }, [blank, id, runtimeTools, busy, ready, pending, nativeConflict, stopCurrentTurn, onRuntimeSummary])

  const resolvedActiveTurn = activeTurn ?? turnItems.at(-1)?.turn ?? null

  return <>
    <div className="dchat-transcript-area" hidden={blank}>
      {!blank && turnItems.length >= 2 && <TurnNavigator items={turnItems} activeTurn={resolvedActiveTurn}
        busyTurn={null} onNavigate={jumpToTurn} t={t} />}
      <div className="dchat-transcript" data-conversation-scroll="" ref={transcript} tabIndex={0} aria-label={t('transcript')} onScroll={event => {
        const node = event.currentTarget
        const currentTop = node.scrollTop
        const previousTop = lastScrollTopRef.current
        lastScrollTopRef.current = currentTop
        if (currentTop !== previousTop) follow.observe(node)
        if (currentTop < previousTop && currentTop < 160 && hiddenMessageCount > 0 && !scrollAnchorRef.current && pendingTurnJumpRef.current === null) {
          loadEarlierMessages()
        }
        if (!scrollRafRef.current) {
          scrollRafRef.current = requestAnimationFrame(() => {
            scrollRafRef.current = 0
            const elNode = transcript.current
            if (!elNode) return
            if (isNearTranscriptBottom(elNode) && turnItems.length) {
              const lastTurn = turnItems.at(-1).turn
              setActiveTurn(prev => (prev === lastTurn ? prev : lastTurn))
            } else if (turnItems.length >= 2) {
              const threshold = elNode.getBoundingClientRect().top + 140
              let currentTurn = turnItems[0].turn
              for (const item of turnItems) {
                if (item.anchor.kind === 'unloaded') continue
                const el = elNode.querySelector(`[data-message-index="${item.anchor.key}"]`)
                if (el && el.getBoundingClientRect().top <= threshold) currentTurn = item.turn
              }
              setActiveTurn(prev => (prev === currentTurn ? prev : currentTurn))
            }
          })
        }
      }}>
        <MarkdownDelegateProvider openFile={openMarkdownFile} openExternalLink={openMarkdownExternalLink}><div ref={transcriptContent} className="dchat-transcript-content">
          {session?.historyNotice && <p className="dchat-history-notice" role="status">{session.historyNotice}</p>}
          {visibleMessages.map((message, index) => {
            const i = hiddenMessageCount + index
            const isLastAssistant = message.role === 'assistant' && i === allMessages.length - 1
            const settleTool = tool => (!busy && tool && (tool.status === 'in_progress' || tool.status === 'pending')
              ? { ...tool, status: 'interrupted' }
              : tool)
            const savedActivity = (message.thought || message.tools?.length || message.plan?.length || message.steps?.length)
              ? {
                  thought: message.thought || '',
                  plan: message.plan || [],
                  tools: (message.tools || []).map(settleTool),
                  steps: message.steps?.map(step => step?.kind === 'tool' ? { ...step, tool: settleTool(step.tool) } : step),
                }
              : null
            return <article className="dchat-message" key={i} data-role={message.role} data-message-index={i}
              aria-label={message.role === 'user' ? t('you') : engineLabel(engines, session.engine)}>
              {message.role === 'assistant' ? <>
                {savedActivity && <TranscriptActivity activity={savedActivity} openFile={openFile} markdown={reasoningMarkdown}
                  expandedTools={activeExpandedTools} toggleExecution={toggleExecution} t={t} />}
                <AssistantMessage message={message} labels={markdownLabels} fileMentions={fileMentions}
                  streaming={busy && isLastAssistant && !hasLiveActivity} />
              </> : <>
                <UserMessage text={message.text} structuredReply={Boolean(currentCapabilities?.structuredUserReply)} />
                {message.attachments?.length > 0 && <Attachments items={message.attachments} t={t}
                  open={diffController && (item => diffController.openFile(id, { path: item.name, attachmentId: item.previewId }))} />}
              </>}
            </article>
          })}
          {hasLiveActivity && <TranscriptActivity activity={activity} openFile={openFile} markdown={reasoningMarkdown} streaming={busy}
            expandedTools={activeExpandedTools} toggleExecution={toggleExecution} t={t} />}
          {busy && (TextShimmer ? <RunningStatus startTime={runStartedAt} paused={false} t={t} />
            : <span className="dchat-status" role="status">{t('chat.deepDiving')}</span>)}
          {session?.stopReason === 'cancelled' && <span className="dchat-status" role="status">{t('cancelled')}</span>}
        </div></MarkdownDelegateProvider>
      </div>
    </div>
    {!blank && !followingTail && <div className="dchat-to-bottom-slot">
      <button type="button" className="dchat-to-bottom" aria-label={t('transcript.toBottom')} onClick={returnToBottom}>
        <IconChevronDownOutlineRegular />
      </button>
    </div>}
    <div className="dchat-input-region" data-centered={blank || undefined}>
      {blank && <>
        <div className="dchat-engine-hero">
          <h1 className="dchat-engine-headline">
            <span className="dchat-engine-headline-button">
              <EngineLogo engine={engine} label={engineLabel(engines, engine)} icon={engines.find(item => item.id === engine)?.meta?.icon} size={38} />
              <span>{engineLabel(engines, engine)}</span>
            </span>
          </h1>
        </div>
        <div className="dchat-workspace-row">
          {engine && <WorkspacePicker value={cwd} onChange={path => {
            if (path !== cwd) {
              const nextComposer = navigation.draftFor({ ...target, cwd: path }, engine)
              const nextSnap = nextComposer.getSnapshot()
              if (!nextSnap.sending && !nextSnap.text && !nextSnap.attachments.length && (draft || attachments.length)) {
                if (draft) nextComposer.setText(draft)
                if (attachments.length) nextComposer.setAttachments(attachments)
              }
            }
            navigation.rememberCwd(path)
            navigation.start(engine, path)
          }} disabled={Boolean(pending)} t={t}
            renderFactorySlot={renderFactorySlot} workspaceSource={workspaceSource} />}
          <EngineDropdown selected={engine} engines={engines} status={engineStatus} reload={reloadEngines}
            disabled={Boolean(pending)} onSelect={async next => {
              if (next && next === engine) return
              if (next === null) {
                const workspace = workspaceSource.getSnapshot().items.find(item => item.path === cwd)
                const effectiveDraft = stagedCommand
                  ? `/${stagedCommand}${draft.trim() ? ` ${draft.trim()}` : ''}`
                  : draft
                try {
                  navigation.selectNative()
                  const transferred = await startNative(workspace?.workspaceId, cwd, effectiveDraft)
                  if (transferred && effectiveDraft && !composer.getSnapshot().sending) {
                    setDraft('')
                    if (stagedCommand) setStagedCommand(null)
                  }
                }
                catch (reason) { navigation.rememberEngine(engine); setError(reason.message || t('request.failed')) }
              } else {
                const nextComposer = navigation.draftFor(target, next)
                const nextSnap = nextComposer.getSnapshot()
                if (!nextSnap.sending && !nextSnap.text && !nextSnap.attachments.length && (draft || attachments.length)) {
                  if (draft) {
                    nextComposer.setText(draft)
                    if (!composer.getSnapshot().sending) setDraft('')
                  }
                  if (attachments.length) {
                    nextComposer.setAttachments(attachments)
                    if (!composer.getSnapshot().sending) setAttachments([])
                  }
                }
                if (stagedCommand && !nextSnap.sending && !nextSnap.command) {
                  nextComposer.setCommand(stagedCommand)
                  if (!composer.getSnapshot().sending) setStagedCommand(null)
                }
                navigation.start(next, cwd)
              }
            }} t={t} />
          {engine && gitInfo?.isGit && <div className="dchat-worktree-slot">
            <WorktreeToggle
              gitInfo={gitInfo}
              enabled={worktreeEnabled}
              from={worktreeFrom}
              disabled={Boolean(pending)}
              onToggle={(checked, currentBranch) => setWorktreeDraft({
                cwd,
                enabled: checked,
                from: checked ? (worktreeFrom !== undefined ? worktreeFrom : currentBranch ?? null) : undefined,
              })}
              onSelectBase={branch => setWorktreeDraft({ cwd, enabled: true, from: branch })}
              onRefreshBranches={refreshGitBranches}
              t={t}
            />
          </div>}
        </div>
      </>}
      {needsEngine && engines.some(item => item.id === target.engine && item.status?.installed === false) && <p role="alert" className="dchat-error">
        {t('engine.cliMissing', { engine: target.engine })}
      </p>}
      {needsEngine && (engineStatus !== 'ready' || !engines.some(item => item.status?.installed !== false)) && <div className="dchat-connection" role="status">
        <span>{t(engineStatus === 'ready' ? 'engine.empty' : engineStatus === 'error' ? 'engine.failed' : 'engine.loading')}</span>
        {engineStatus === 'error' && <Button size="sm" onClick={() => void reloadEngines()}>{t('engine.retry')}</Button>}
      </div>}
      {!readOnly && session?.permissions.length > 0 && <div className="dchat-approvals">
        {session.permissions.map(permission => <PermissionCard key={permissionId(permission)} request={permission} t={t}
          openFile={openFile}
          disabled={!ready || Boolean(pending)} select={option => perform('approve', { id: permissionId(permission), option })} />)}
      </div>}
      {(error || sendError || session?.error || invalidEvent) && <p role="alert" className="dchat-error">
        {error || sendError || session?.error || t('stream.invalid')}
      </p>}
      {connectionError && <div className="dchat-connection dchat-error" role="alert">
        <span>{connectionError}</span>
        <Button size="sm" onClick={() => {
          if (id) setConnectAttempt(value => value + 1)
          else setPrepareAttempt(value => value + 1)
        }}>{t('reconnect')}</Button>
      </div>}
      {readOnly && <p className="dchat-history-notice" role="status">{t(session?.archived ? 'session.archived' : 'session.readOnly')}</p>}
      {!needsEngine && !readOnly && (() => {
        const planItems = activity.plan.length ? activity.plan : (session?.messages?.at(-1)?.plan ?? [])
        const todos = planItems.map(item => ({
          content: String(item.content ?? ''),
          status: ['completed', 'in_progress', 'pending'].includes(item.status) ? item.status : 'pending',
        })).filter(item => item.content)
        return todos.length > 0 ? <TodoPanel todos={todos} t={queueDock?.t ?? t} /> : null
      })()}
      {session?.queuePaused && queue.length > 0 && !readOnly &&
        <Button size="sm" disabled={!ready || busy || Boolean(pending)} onClick={() => void perform('queue', {action:'resume'})}>{t('queue.resume')}</Button>}
      {!needsEngine && !readOnly && (queue.length > 0 || queueEcho) && <MessageQueue source={queueDock} renderFactorySlot={renderFactorySlot}
        id={id} queue={queue} pending={queueEcho} canSteer={canSteer} enabled={ready && !pending}
        change={async (action, queuedId, text) => {
          const ok = await perform('queue', { action, id: queuedId, text })
          if (!ok) throw new Error('Queue action was not applied')
        }}
        fallback={<QueuedMessages queue={queue} canSteer={canSteer} disabled={!ready || Boolean(pending)}
          change={(action, queuedId) => perform('queue', { action, id: queuedId })} t={t} />} />}
      {!needsEngine && !readOnly && <form className={inputLayout.card + ' dchat-composer'} tabIndex={-1} data-composer-card onSubmit={event => { event.preventDefault(); void send() }}
        data-files-hover={draggingFiles || undefined}
        onDragEnter={event => {
          if (!hasDraggedFiles(event.dataTransfer)) return
          event.preventDefault()
          if (pending === 'prompt') return
          fileDragDepth.current++
          setDraggingFiles(true)
        }}
        onDragOver={event => {
          if (!hasDraggedFiles(event.dataTransfer)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = pending === 'prompt' ? 'none' : 'copy'
        }}
        onDragLeave={() => {
          if (!fileDragDepth.current) return
          fileDragDepth.current--
          if (!fileDragDepth.current) setDraggingFiles(false)
        }}
        onDrop={event => {
          if (!hasDraggedFiles(event.dataTransfer)) return
          event.preventDefault()
          fileDragDepth.current = 0
          setDraggingFiles(false)
          if (Array.from(event.dataTransfer.items ?? []).some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
            setError(t('attachment.directory'))
            return
          }
          stage(Array.from(event.dataTransfer.files))
        }}>
        {commandPicker.dropdown}
        {attachments.length > 0 && <Attachments items={attachments.map(({ id, file }) => ({ id, name: file.name }))}
          disabled={pending === 'prompt'} remove={id => {
            setError('')
            setAttachments(items => items.filter(item => item.id !== id))
          }} t={t} />}
        {stagedCommand && <div className="dchat-staged-commands">
          <span className="dchat-staged-command">
            <span className="dchat-staged-command-label">
              /{stagedTitle || stagedCommand}
              {stagedTitle && <code>/{stagedCommand}</code>}
            </span>
            <button type="button" className="dchat-staged-command-remove"
              aria-label={t('cmd.remove', { name: stagedTitle || `/${stagedCommand}` })} disabled={sending}
              onClick={() => {
                setStagedCommand(null)
                input.current?.focus({ preventScroll: true })
              }}>
              <IconCloseOutlineRegular size={12} />
            </button>
          </span>
        </div>}
        <div className="dchat-composer-input-wrap">
          <textarea className={inputLayout.input} ref={input} value={draft} {...commandPicker.inputProps} aria-label={t('message')}
            rows={blank ? 2 : 1} readOnly={pending === 'prompt'} onPaste={event => {
            if (!capabilities.image) return
            const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'))
            stage(files)
          }} onKeyDown={event => {
            if (commandPicker.handleInputKey(event)) return
            if (event.key === 'Backspace' && stagedCommand && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0) {
              event.preventDefault()
              setStagedCommand(null)
              return
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (canSteerQueue && (event.ctrlKey || event.metaKey)) void perform('queue', {action:'steer-all'})
              else void send(deliveryFor(event.ctrlKey || event.metaKey))
            }
          }} />
          {!draft && <span className={inputLayout.placeholder + ' dchat-composer-placeholder'} aria-hidden="true">
            {canSteerQueue ? queueDock.t('placeholder.steerQueue') : t(blank ? 'message.hero' : 'message')}
          </span>}
        </div>
        <div className={inputLayout.row + ' dchat-composer-bar'}>
          <div className="dchat-composer-tools">
            <input type="file" hidden multiple ref={fileInput} onChange={event => {
              stage(Array.from(event.target.files))
              event.target.value = ''
            }} />
            {commandPicker.plus}
            {(otherOptions.length > 0 || displayedAccount) && <button type="button" className="dchat-mobile-options"
              aria-label={t('composer.sessionOptions')} aria-controls={optionsRowId} aria-expanded={mobileOptionsOpen}
              onClick={() => setMobileOptionsOpen(value => !value)}>
              <IconSlidersTwoOutlineRegular size={18} />
            </button>}
          </div>
          <div id={optionsRowId} className="dchat-composer-options" data-expanded={mobileOptionsOpen || undefined}>
            {otherOptions.map(option => <ConfigMenu key={option.id} option={option} change={changeConfig}
              open={option.category === 'mode' ? modeMenuOpen : undefined}
              onOpenChange={option.category === 'mode' ? setModeMenuOpen : undefined}
              disabled={configDisabled} t={t} />)}
            {displayedAccount && <SessionAccount engine={currentEngine} account={displayedAccount}
              disabled={blank ? Boolean(pending) || busy : configDisabled || readOnly}
              change={id => blank ? selectDraftProfile(engine, id) : perform('account', { profileId: id })}
              manage={() => setAccountSettingsOpen(true)} t={t} />}
          </div>
          <div className="dchat-composer-trailing">
            {model || effort ? <ModelConfigMenu model={model} effort={effort} commands={teamCommands}
              chooseCommand={commandPicker.stageNative} change={changeConfig} triggerRef={modelTriggerRef}
              disabled={configDisabled} t={t} /> :
              !connectionError && (ready
                ? <Button size="sm" className="dchat-option-trigger" title={t('model.reload')}
                    aria-label={t('model.reload')} disabled={configDisabled}
                    onClick={() => setConnectAttempt(value => value + 1)}>
                    <IconDataOutlineRegular size={16} /><span>{t('model.pending')}</span>
                  </Button>
                : <span className="dchat-status" role="status"><StateDot state="ongoing" />{t('connecting')}</span>)}
            {busy && <button type="button" className={inputLayout.primary + ' dchat-send'} data-secondary={hasDraft || undefined}
              title={t('stop.current')} aria-label={t('stop.current')}
              disabled={!ready || Boolean(pending)} onClick={() => perform('cancel')}>{IconStopFillRegular ? <IconStopFillRegular size={16} /> : <span aria-hidden="true">■</span>}</button>}
            {(!busy || hasDraft) && <>
              {canSteerDraft && <Menu open={deliveryMenuOpen && canSendPrompt} portal side="top" align="end"
                onClose={() => setDeliveryMenuOpen(false)} items={['queue','steer'].map(id => ({ id, label: t(`send.${id}`) }))}
                selectedId={primaryDelivery} onSelect={delivery => { setDeliveryMenuOpen(false); void send(delivery) }}
                anchor={<Button size="sm" aria-label={t('send.options')} title={t('send.options')}
                  disabled={!canSendPrompt} onClick={() => setDeliveryMenuOpen(open => !open)}>
                  <IconChevronDownOutlineRegular size={14} />
                </Button>} />}
              <button type="submit" className={inputLayout.primary + ' dchat-send'} title={sendLabel} aria-label={sendLabel} disabled={!canSendPrompt}>
                {pending === 'prompt' ? <StateDot state="ongoing" /> : <IconSendOutlineRegular size={18} />}
              </button>
            </>}
          </div>
        </div>
      </form>}
      <div className="dchat-session-footer">
        {(needsEngine || readOnly) && displayedAccount && <SessionAccount engine={currentEngine} account={displayedAccount}
          disabled={blank ? Boolean(pending) || busy : configDisabled || readOnly}
          change={id => blank ? selectDraftProfile(engine, id) : perform('account', { profileId: id })}
          manage={() => setAccountSettingsOpen(true)} t={t} />}
        <SessionStatus sessionId={id} engine={currentEngine} profileId={session?.account?.id} engineCapabilities={currentCapabilities}
          messages={session?.messages} model={model?.currentValue}
          modelName={configGroups(model).flatMap(group => group.choices).find(choice => choice.value === model?.currentValue)?.name} effort={effort?.currentValue} agentCount={session?.agents?.length}
          createdAt={session?.createdAt} updatedAt={session?.updatedAt} usage={activity.usage} metrics={session?.metrics} settings={performanceSettings} t={t} />
      </div>
    </div>
    {commandDialog === 'review' && <ReviewCommand t={t}
      replaceDraft={Boolean(stagedCommand || (draft.trim() && !'/review'.startsWith(draft.trim().toLowerCase())))}
      close={() => setCommandDialog(null)} stage={text => {
        setCommandDialog(null)
        setStagedCommand(null)
        commandPicker.stageText(text)
      }} />}
    {commandDialog === 'compact' && <Modal open title={t('composer.compactTitle')} description={t('composer.compactDescription')}
      closeLabel={t('close')} onClose={() => setCommandDialog(null)} footer={<>
        <Button variant="outline" data-modal-autofocus onClick={() => setCommandDialog(null)}>{t('cancel')}</Button>
        <Button variant="primary" onClick={() => { setCommandDialog(null); void executeImmediateCommand('/compact') }}>{t('composer.stageCommand')}</Button>
      </>} />}
    {commandDialog === 'mcp' && <McpStatusDialog id={id} close={() => setCommandDialog(null)} t={t} />}
    {!readOnly && parallelOpen && <ParallelTasks id={id} ready={ready && canStartParallel}
      launched={() => navigation.refreshHistory?.()} close={() => setParallelOpen(false)} t={t} />}
    {accountSettingsOpen && <Modal open title={t('engine.manageAccountsTitle')} closeLabel={t('close')}
      className="dchat-account-modal" contentClassName="dchat-account-modal-body"
      onClose={() => setAccountSettingsOpen(false)}>
      <EngineSettings engineSource={engineSource} focusedEngine={currentEngine} t={t} />
    </Modal>}
  </>
}

function McpStatusDialog({ id, close, t }) {
  const [state, setState] = useState({ loading: true })
  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    fetch(`/api/direct-chat/sessions/${encodeURIComponent(id)}/mcp`, { signal: controller.signal, credentials: 'same-origin' })
      .then(async response => {
        const data = await response.json().catch(() => undefined)
        if (!response.ok || !data) throw new Error(data?.message || `HTTP ${response.status}`)
        return data
      })
      .then(data => { if (!controller.signal.aborted) setState({ loading: false, ...data }) },
        error => { if (!controller.signal.aborted) setState({ loading: false, error: error.message }) })
    return () => controller.abort()
  }, [id])
  return <Modal open title={t('composer.mcpTitle')} closeLabel={t('close')} onClose={close}
    footer={<Button variant="primary" data-modal-autofocus onClick={close}>{t('close')}</Button>}>
    {state.loading ? <p className="dchat-status" role="status"><StateDot state="ongoing" />{t('composer.mcpLoading')}</p>
      : state.error ? <p className="dchat-error" role="alert">{state.error}</p>
      : state.status !== 'available' || !state.text ? <p className="dchat-status">{t('composer.mcpUnavailable')}</p>
      : <div className="dchat-mcp-body"><MarkdownText text={state.text} /></div>}
  </Modal>
}

function QueuedMessages({ queue, paused, busy, canSteer, disabled, change, t }) {
  return <section className="dchat-queue" aria-label={t('queue.title')}>
    <div className="dchat-queue-heading">
      <span>{t('queue.count', { count: queue.length })}</span>
      {paused && <Button size="sm" disabled={disabled || busy} onClick={() => void change('resume')}>{t('queue.resume')}</Button>}
    </div>
    <ol className="dchat-queue-list">
      {queue.map(item => {
        const text = [item.text, ...(item.attachments ?? []).map(file => file.name)].filter(Boolean).join(' · ')
        const steerable = canSteer && !item.attachments?.length && item.text?.trim() && !item.text.trimStart().startsWith('/')
        return <li key={item.id}>
          <span className="dchat-queue-text" title={text}>{text}</span>
          {steerable && <Button size="sm" disabled={disabled} title={t('send.steer')} aria-label={t('send.steer')}
            onClick={() => void change('steer', item.id)}><IconSendOutlineRegular size={14} /></Button>}
          <Button size="sm" disabled={disabled} title={t('queue.remove')} aria-label={t('queue.remove')}
            onClick={() => void change('remove', item.id)}><IconCloseOutlineRegular size={14} /></Button>
        </li>
      })}
    </ol>
  </section>
}

function Attachments({ items, open, remove, disabled, t }) {
  return <div className="dchat-attachments">
    <AttachmentRail items={items.map((item, index) => ({ id: String(remove ? item.id : index), item }))}
      labels={{ group: t('attachments'), scrollLeft: t('attachment.scrollLeft'), scrollRight: t('attachment.scrollRight') }}
      renderItem={({ item }) => <div className="dchat-attachment">
        <IconPaperclipOutlineRegular size={14} />
        {open && item.previewId ? <button type="button" className="dchat-attachment-preview"
          title={item.name} aria-label={t('file.open', { path: item.name })} onClick={() => open(item)}>{item.name}</button>
          : <span title={item.name}>{item.name}</span>}
        {remove && <Button type="button" size="sm" aria-label={t('attachment.remove', { name: item.name })}
          disabled={disabled} onClick={() => remove(item.id)}><IconCloseOutlineRegular size={12} /></Button>}
      </div>} />
  </div>
}

function SessionAccount({ engine, account, disabled, change, manage, t }) {
  const [open, setOpen] = useState(false)
  const canSwitch = account.canSwitch && !disabled && account.choices?.some(choice => choice.id !== account.id)
  const blocked = account.switchBlockedReason
  const canManage = Boolean(manage) && !disabled && !blocked
  const selectable = canSwitch || canManage
  useEffect(() => { if (!selectable) setOpen(false) }, [selectable])
  const baseLabel = item => accountChoiceLabel(item, t('engine.defaultAccount'))
  const profileLabel = item => {
    const label = baseLabel(item)
    if (engine !== 'agy' || !account.choices?.some(other => other.id !== item.id && baseLabel(other) === label)) return label
    if (item.id === 'default') return label + ' · ' + t('engineSettings.agyNative')
    const suffix = account.choices.filter(other => other.id !== 'default' && baseLabel(other) === label).length > 1 ? ' ' + item.id : ''
    return label + ' · ' + t('engineSettings.agyIsolated') + suffix
  }
  const label = profileLabel(account)
  const reason = ['busy', 'history', 'readOnly', 'unavailable'].includes(blocked) ? t('engine.switch.' + blocked) : ''
  const title = [t('engine.profileLabel') + ' · ' + label, reason].filter(Boolean).join(' — ')
  const content = <><IconUsersOutlineRegular size={14} /><span>{label}</span></>
  if (!selectable) {
    return <Button type="button" size="sm" className="dchat-session-account" disabled title={title} aria-label={title}>
      {content}
    </Button>
  }
  const choices = account.choices?.length ? account.choices : [account]
  const items = choices.map(choice => ({
    id: choice.id,
    label: profileLabel(choice),
    disabled: !canSwitch && choice.id !== account.id,
  }))
  if (canManage) {
    items.push(
      { type: 'separator', id: 'manage-sep' },
      { id: '__manage__', label: t('engine.manageAccounts'), icon: <IconPlusOutlineRegular size={14} /> },
    )
  }
  return <Menu open={open} portal side="top" align="start" dense onClose={() => setOpen(false)}
    selectedId={account.id} items={items} onSelect={id => {
      setOpen(false)
      if (id === '__manage__') {
        manage()
        return
      }
      if (canSwitch && id !== account.id) void change(id)
    }} anchor={<Button size="sm" className="dchat-session-account" title={title} aria-label={title}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {content}<IconChevronDownOutlineRegular size={12} />
    </Button>} />
}

function ConfigMenu({ option, change, open: controlledOpen, onOpenChange, disabled, t }) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen
  const label = ['model', 'thought_level', 'mode'].includes(option.category) ? t(option.category) : option.name
  const groups = configGroups(option)
  const selected = groups.flatMap(group => group.choices).find(choice => choice.value === option.currentValue)
  const rows = groups.flatMap(({ name, choices }, index) => [
    ...(name ? [{ type: 'label', id: `group:${index}`, text: name }] : []),
    ...choices.map(choice => ({ id: choice.value, label: <span title={choice.description}>{choice.name}</span> })),
  ])
  return <Menu open={open} portal autoFocus side="top" align="end" dense onClose={() => setOpen(false)}
    listClassName="dchat-config-menu" className="dchat-config-anchor" items={rows} selectedId={selected?.value}
    onSelect={value => {
      setOpen(false)
      if (value !== option.currentValue) change(option.id, value)
    }}
    anchor={<Button size="sm" className="dchat-option-trigger" disabled={disabled}
      aria-label={label} title={selected?.name ?? label} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(!open)}>
      <span className="dchat-option-selection">{selected?.name ?? label}</span>
      <IconChevronDownOutlineRegular size={12} />
    </Button>} />
}

function ModelConfigMenu({ model, effort, commands, chooseCommand, change, triggerRef, disabled, t }) {
  const [pane, setPane] = useState(null)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(null)
  const [selection, setSelection] = useState(null)
  const selecting = selection !== null
  const root = useRef(null)
  const trigger = useRef(null)
  const setTriggerRef = node => {
    trigger.current = node
    if (triggerRef) triggerRef.current = node
  }
  const menu = useRef(null)
  const search = useRef(null)
  const scroll = useRef(null)
  const returnTo = useRef(null)
  const id = useId().replace(/[^a-z\d-]/gi, '')
  const anchor = { '--dchat-model-anchor': `--dchat-model-${id}` }
  const modelGroups = useMemo(() => configGroups(model), [model])
  const effortGroups = useMemo(() => configGroups(effort), [effort])
  const models = useMemo(() => modelGroups.flatMap(group => group.choices), [modelGroups])
  const currentModel = models.find(choice => choice.value === model?.currentValue)?.name
  const currentEffort = effortGroups.flatMap(group => group.choices).find(choice => choice.value === effort?.currentValue)?.name
  const modelLabel = model && (currentModel ?? t('model.choose'))
  const effortLabel = effort && (currentEffort ?? t('model.effort'))
  const label = currentModel && currentEffort ? t('model.currentEffort', { model: currentModel, effort: currentEffort })
    : currentModel ? t('model.current', { model: currentModel }) : modelLabel ?? effortLabel
  const showSearch = pane === 'model' && models.length > 4
  const groups = useMemo(() => {
    if (pane === 'effort') return effortGroups
    if (pane !== 'model') return []
    if (!showSearch || !query.trim()) return modelGroups
    return modelGroups.map(group => ({ ...group, choices: rankByName(group.choices, query.trim()) }))
      .filter(group => group.choices.length > 0)
  }, [pane, effortGroups, modelGroups, showSearch, query])
  const choices = useMemo(() => groups.flatMap(group => group.choices), [groups])
  const activeOption = pane === 'effort' ? effort : model
  const selectedIndex = choices.findIndex(choice => choice.value === activeOption?.currentValue)
  const activeIndex = Math.min(highlight ?? Math.max(0, selectedIndex), choices.length - 1)
  const open = pane !== null
  const hasRoot = Boolean(currentModel) || commands.length > 0

  const close = restoreFocus => {
    if (restoreFocus && trigger.current) focusWithoutRing(trigger.current, { preventScroll: true })
    setPane(null)
  }
  const show = next => {
    setQuery('')
    setHighlight(null)
    returnTo.current = null
    setPane(next)
  }
  const back = () => {
    if (!hasRoot || pane === 'root') {
      close(true)
    } else {
      returnTo.current = pane
      setPane('root')
    }
  }
  const openPane = hasRoot ? 'root' : model ? 'model' : 'effort'

  useEffect(() => {
    if (!open) return
    const onPointerDown = event => {
      if (!root.current?.contains(event.target) && !menu.current?.contains(event.target)) setPane(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])
  useEffect(() => {
    if (disabled && !selecting) setPane(null)
  }, [disabled, selecting])
  useLayoutEffect(() => {
    if (!pane) return
    if (pane === 'root') {
      if (returnTo.current) menu.current?.querySelector(`[data-pane="${returnTo.current}"]`)?.focus({ preventScroll: true })
      returnTo.current = null
    } else if (showSearch && !isMobileDevice()) {
      search.current?.focus({ preventScroll: true })
    } else {
      const checked = menu.current?.querySelector('[aria-checked="true"]')
      const first = menu.current?.querySelector('[role="menuitemradio"]')
      const initial = checked ?? first ?? trigger.current
      initial?.focus({ preventScroll: true })
    }
  }, [pane, showSearch])
  useEffect(() => {
    if (scroll.current && groups.some(group => group.name)) return observeStickyMenuGroups(scroll.current)
  }, [groups])
  useLayoutEffect(() => {
    if (showSearch && activeIndex >= 0) {
      scroll.current?.querySelector(`[data-choice="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [showSearch, activeIndex, choices])

  const choose = async choice => {
    if (disabled || selecting || !activeOption) return
    if (choice.value === activeOption.currentValue) {
      close(true)
      return
    }
    focusWithoutRing(trigger.current, { preventScroll: true })
    setSelection(choice.value)
    try {
      if (await change(activeOption.id, choice.value)) close(true)
    } finally {
      setSelection(null)
    }
  }
  const onKeyDown = event => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
    const { key, shiftKey, target } = event
    if (!open) {
      if (key === 'ArrowDown' && !disabled) {
        event.preventDefault()
        show(openPane)
      }
      return
    }
    if (key === 'Escape' || (key === 'Tab' && shiftKey)) {
      event.preventDefault()
      if (!event.repeat) back()
      return
    }
    const rows = Array.from(menu.current?.querySelectorAll('button[role]:not(:disabled)') ?? [])
    const hasSearchFocus = showSearch && target === search.current
    if (key === 'Tab' || (key === 'Enter' && hasSearchFocus)) {
      if (hasSearchFocus && !choices[activeIndex]) return
      const row = rows.includes(target) ? target : null
      if (hasSearchFocus || row || target === trigger.current) {
        event.preventDefault()
        if (hasSearchFocus) choose(choices[activeIndex])
        else if (row) row.click()
        else (showSearch ? search.current : rows.find(item => item.getAttribute('aria-checked') === 'true') ?? rows[0])?.focus()
      }
      return
    }
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return
    event.preventDefault()
    const step = key === 'ArrowDown' ? 1 : -1
    if (showSearch && choices.length > 0 && !disabled) {
      setHighlight((activeIndex + step + choices.length) % choices.length)
      search.current?.focus({ preventScroll: true })
    } else if (rows.length > 0) {
      const from = rows.indexOf(target)
      const next = from < 0 ? (step > 0 ? 0 : rows.length - 1) : (from + step + rows.length) % rows.length
      rows[next].focus()
    }
  }
  const changeQuery = value => {
    setQuery(value)
    setHighlight(0)
  }
  const menuLabel = model && effort ? t('model.menu') : t(model ? 'model' : 'thought_level')
  let choiceIndex = 0
  return <div ref={root} className="dchat-model" onKeyDown={onKeyDown} onBlur={event => {
    if (event.relatedTarget && !root.current?.contains(event.relatedTarget) && !menu.current?.contains(event.relatedTarget)) close()
  }} onMouseDown={event => {
    if (event.target.closest('button')) event.preventDefault()
  }}>
    <button ref={setTriggerRef} className="dchat-model-trigger" style={anchor} type="button"
      disabled={disabled && !selecting} aria-disabled={selecting || undefined} aria-busy={selecting}
      aria-label={label} title={[modelLabel, effortLabel].filter(Boolean).join(' · ')}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `dchat-model-menu-${id}` : undefined}
      onClick={() => {
        if (disabled || selecting) return
        trigger.current.focus()
        if (open) close(true)
        else show(openPane)
      }}>
      <IconDataOutlineRegular className="dchat-model-icon" size={16} />
      {modelLabel && <span className="dchat-model-name">{modelLabel}</span>}
      {effortLabel && <span className="dchat-model-effort">{effortLabel}</span>}
      {selecting ? <StateDot state="ongoing" /> : <IconChevronDownOutlineRegular className="dchat-model-chevron" size={12} />}
    </button>
    {open && createPortal(<MenuSurface ref={menu} className="dchat-model-menu" style={anchor}
      id={`dchat-model-menu-${id}`} role={showSearch ? 'group' : 'menu'} aria-label={menuLabel}
      aria-busy={selecting}>
      {pane === 'root' ? <>
        {model && <button className="dchat-model-cell" type="button" role="menuitem" data-pane="model" onClick={() => show('model')}>
          <span>{t('model')}</span><span>{modelLabel}</span><IconChevronRightOutlineRegular size={12} />
        </button>}
        {effort && <button className="dchat-model-cell" type="button" role="menuitem" data-pane="effort" onClick={() => show('effort')}>
          <span>{t('model.effort')}</span><span>{effortLabel}</span><IconChevronRightOutlineRegular size={12} />
        </button>}
        {commands.map(command => <button className="dchat-model-cell dchat-model-command" key={command.name}
          type="button" role="menuitem" title={command.description} onClick={() => {
            close()
            chooseCommand(command.name)
          }}>
          <span>{t(`model.${command.name}`)}</span>
          <span>
            {command.name === 'swarm' && <small>{t('model.swarmUsage')}</small>}
            <code>/{command.name}</code>
          </span>
        </button>)}
      </> : <>
        {showSearch && <div className="dchat-model-search" data-query={Boolean(query) || undefined}>
          <Input ref={search} type="text" role="searchbox" className="dchat-model-search-input" value={query}
            aria-label={t('model.search')} placeholder={t('model.search')} readOnly={disabled}
            aria-controls={`dchat-model-results-${id}`}
            aria-activedescendant={activeIndex < 0 ? undefined : `dchat-model-${id}-${activeIndex}`}
            onChange={event => changeQuery(event.target.value)} />
          {query && <button type="button" aria-label={t('model.clearSearch')} disabled={disabled} onClick={() => {
            changeQuery('')
            search.current?.focus()
          }}><IconCloseFillRegular size={16} /></button>}
        </div>}
        <div ref={scroll} id={`dchat-model-results-${id}`} className="dchat-model-choices scrollable"
          data-searchable={showSearch || undefined}
          role={showSearch ? 'menu' : undefined} aria-label={showSearch ? t('model') : undefined}>
          {groups.map(({ name, choices: groupChoices }, groupIndex) => {
            const rows = groupChoices.map(choice => {
              const index = choiceIndex++
              const selected = index === selectedIndex
              return <button key={choice.value} type="button" role="menuitemradio" aria-checked={selected}
                id={`dchat-model-${id}-${index}`} data-choice={index}
                data-highlighted={showSearch && index === activeIndex ? '' : undefined} className="dchat-model-option"
                disabled={disabled || selecting} tabIndex={showSearch ? -1 : 0}
                onMouseMove={showSearch ? () => setHighlight(index) : undefined} onClick={() => choose(choice)}>
                <span title={choice.description || choice.name}>{choice.name}</span>
                {selection === choice.value ? <StateDot state="ongoing" /> : selected && <IconCheckOutlineRegular size={14} />}
              </button>
            })
            return name ? <MenuGroup key={groupIndex} label={name}>{rows}</MenuGroup> : rows
          })}
        </div>
        {showSearch && choices.length === 0 && <span className="dchat-model-empty" role="status">{t('model.noMatches')}</span>}
      </>}
    </MenuSurface>, document.body)}
  </div>
}

function ParallelTasks({ id, ready, launched, close, t }) {
  const formId = useId()
  const form = useRef(null)
  const nextId = useRef(2)
  const focusTask = useRef(null)
  const lastRequest = useRef(null)
  const [items, setItems] = useState([{ id: 0, text: '' }, { id: 1, text: '' }])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const tasks = items.map(item => item.text.trim()).filter(Boolean)

  useLayoutEffect(() => {
    if (focusTask.current === null) return
    form.current?.querySelector(`[data-task-id="${focusTask.current}"]`)?.focus()
    focusTask.current = null
  }, [items.length])
  const submit = async event => {
    event.preventDefault()
    if (pending || !ready || tasks.length === 0) return
    const key = JSON.stringify(tasks)
    if (lastRequest.current?.key !== key) {
      const requestId = crypto.randomUUID?.() ?? crypto.getRandomValues(new Uint32Array(4)).join('-')
      lastRequest.current = { key, requestId }
    }
    setPending(true)
    setError('')
    try {
      await sessionAction(id, 'parallel', { tasks, requestId: lastRequest.current.requestId })
      launched()
      close()
    } catch (error) {
      setError(error.message || t('request.failed'))
    } finally {
      setPending(false)
    }
  }
  const dismiss = () => { if (!pending) close() }

  return <Modal open onClose={dismiss} title={t('parallel.title')} closeLabel={t('close')}
    description={t('parallel.description')} className="dchat-parallel-dialog"
    contentClassName="dchat-parallel-content"
    footer={<>
      <Button size="sm" onClick={dismiss} disabled={pending}>{t('cancel')}</Button>
      <Button size="sm" variant="primary" type="submit" form={formId} disabled={pending || !ready || tasks.length === 0}>
        {t(pending ? 'parallel.starting' : 'parallel.start')}
      </Button>
    </>}>
    <form id={formId} ref={form} className="dchat-parallel-form" onSubmit={submit}>
      {items.map((item, index) => <div className="dchat-parallel-task" key={item.id}>
        <div className="dchat-parallel-task-header">
          <label htmlFor={`${formId}-task-${item.id}`} className="dchat-parallel-badge">{index + 1}</label>
          <span className="dchat-parallel-task-title">{t('parallel.task', { index: index + 1 })}</span>
          {items.length > 1 && <Button size="sm" className="dchat-parallel-remove" disabled={pending}
            aria-label={t('parallel.remove', { index: index + 1 })}
            onClick={() => {
              focusTask.current = items[index + 1]?.id ?? items[index - 1]?.id
              setItems(items.filter(task => task.id !== item.id))
            }}>
            <IconCloseOutlineRegular size={12} />
          </Button>}
        </div>
        <textarea id={`${formId}-task-${item.id}`} data-task-id={item.id} rows={2} maxLength={16000}
          data-modal-autofocus={index === 0 ? '' : undefined} value={item.text} readOnly={pending}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void submit()
            }
          }}
          onChange={event => setItems(items.map(task => task.id === item.id ? { ...task, text: event.target.value } : task))} />
      </div>)}
      {items.length < 4 && <Button size="sm" className="dchat-parallel-add" icon={<IconPlusOutlineRegular size={14} />}
        disabled={pending} onClick={() => {
          const task = { id: nextId.current++, text: '' }
          focusTask.current = task.id
          setItems([...items, task])
        }}>{t('parallel.add')}</Button>}
      {error && <p role="alert" className="dchat-error">{error}</p>}
      {!ready && !error && <p role="status" className="dchat-status">{t('disconnected')}</p>}
    </form>
  </Modal>
}

function SubagentCatalog({ summary, openChild, t }) {
  const [open, setOpen] = useState(false)
  const root = useRef(null)
  const trigger = useRef(null)
  const count = useRef(null)
  const panel = useRef(null)
  const hover = useRef(null)
  const pinned = useRef(false)
  const nextFocus = useRef(null)
  const id = useId()
  const anchorName = `--dchat-subagents-${id.replace(/[^a-z\d-]/gi, '')}`
  const agents = summary?.agents ?? noAgents
  const running = agents.filter(agent => agent.status === 'running' || agent.status === 'in_progress').length
  const label = summary?.ready || agents.length
    ? t(agents.length === 1 ? 'agents.count.one' : 'agents.count.other', { count: agents.length })
    : t('agents.title')
  const rows = () => Array.from(panel.current?.querySelectorAll('[role="treeitem"]:not([aria-disabled="true"])') ?? [])
  const close = useCallback((restoreFocus = false) => {
    clearTimeout(hover.current)
    pinned.current = false
    nextFocus.current = null
    setOpen(false)
    if (restoreFocus && trigger.current) focusWithoutRing(trigger.current)
  }, [])

  useEffect(() => {
    if (!open) return
    const inside = node => root.current?.contains(node) || panel.current?.contains(node)
    const pointerDown = event => {
      if (!inside(event.target)) close()
    }
    const onEscape = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const restoreFocus = inside(document.activeElement)
      if (restoreFocus) event.preventDefault()
      close(restoreFocus)
    }
    document.addEventListener('pointerdown', pointerDown)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', pointerDown)
      document.removeEventListener('keydown', onEscape)
    }
  }, [open, close])
  useEffect(() => () => clearTimeout(hover.current), [])
  useLayoutEffect(() => {
    if (!open || !nextFocus.current) return
    const destination = nextFocus.current === 'first' ? rows()[0] ?? panel.current : panel.current
    nextFocus.current = null
    destination?.focus()
  }, [open])

  const show = focus => {
    clearTimeout(hover.current)
    pinned.current = true
    if (open && panel.current) {
      const destination = focus === 'first' ? rows()[0] ?? panel.current : panel.current
      destination.focus()
    } else {
      nextFocus.current = focus
      setOpen(true)
    }
  }
  const hoverShow = event => {
    clearTimeout(hover.current)
    if (open || event.pointerType === 'touch' || getComputedStyle(count.current).display === 'none') return
    hover.current = setTimeout(() => setOpen(true), 150)
  }
  const hoverClose = () => {
    clearTimeout(hover.current)
    if (!pinned.current) hover.current = setTimeout(() => close(), 120)
  }
  const navigate = event => {
    if (event.target === trigger.current && event.key === 'ArrowDown') {
      event.preventDefault()
      show('first')
      return
    }
    if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = rows()
    if (!items.length) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? current + 1 : current < 0 ? items.length - 1 : current - 1
    items[(next + items.length) % items.length].focus()
  }
  return <div className="dchat-agent-catalog" ref={root} onKeyDown={navigate} onPointerLeave={hoverClose}>
    <Tooltip label={label} disabled={open} delayMs={500} portal side="bottom">
      <button type="button" className="dchat-agent-trigger" ref={trigger} style={{ anchorName }}
        aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${id}-catalog` : undefined}
        aria-describedby={running ? `${id}-running` : undefined}
        onPointerEnter={hoverShow} onClick={() => {
          if (open && pinned.current) close(true)
          else show('panel')
        }}>
        <span className="dchat-agent-glyph" aria-hidden>
          <IconUsersOutlineRegular size={14} className={running ? 'dchat-agent-compact-icon' : undefined} />
          {running > 0 && <StateDot state="ongoing" className="dchat-agent-trigger-spinner" />}
        </span>
        <span className="dchat-agent-count" ref={count}>{label}</span>
      </button>
    </Tooltip>
    {running > 0 && <span id={`${id}-running`} hidden>{t('agents.activity', { count: running })}</span>}
    {open && createPortal(<MenuSurface ref={panel} id={`${id}-catalog`} className="dchat-agent-panel"
      role="dialog" aria-label={t('agents.catalog')} tabIndex={-1} style={{ positionAnchor: anchorName }}
      onPointerEnter={() => clearTimeout(hover.current)} onPointerLeave={hoverClose}>
      <div className="dchat-agent-panel-body">
        {summary?.error && <p className="dchat-agent-notice" role="alert">{summary.error}</p>}
        {agents.length > 0 ? <div role="tree" aria-label={t('agents.catalog')}>
          {agents.map(agent => <SubagentRow key={agent.id} agent={agent} openChild={id => {
            close()
            openChild(id)
          }} t={t} />)}
        </div> : !summary?.error && <p className="dchat-agent-notice" role="status">
          {t(summary?.ready ? 'agents.empty' : 'agents.loading')}
        </p>}
      </div>
    </MenuSurface>, document.body)}
  </div>
}

function SubagentRow({ agent, openChild, t }) {
  const labels = {
    idle: 'agents.idle', queued: 'agents.queued', running: 'agents.running', waiting: 'agents.waiting',
    cancelled: 'agents.cancelled', interrupted: 'agents.interrupted',
    pending: 'pending', in_progress: 'in_progress', completed: 'completed', failed: 'failed',
  }
  const states = {
    running: 'ongoing', in_progress: 'ongoing', waiting: 'warning', completed: 'done', failed: 'error',
  }
  const name = agent.name || agent.id
  const parallel = agent.kind === 'parallel' || (!agent.kind && agent.sessionId)
  const caption = [parallel ? t('agents.parallel') : null, agent.detail].filter(Boolean).join(' · ')
  const status = Object.hasOwn(labels, agent.status) ? t(labels[agent.status]) : agent.status
  const launch = agent.sessionId ? () => openChild(agent.sessionId) : undefined
  return <div className="dchat-agent-row" role="treeitem" tabIndex={launch ? 0 : -1} aria-level={1}
    aria-disabled={!launch || undefined} aria-label={[name, caption, status].filter(Boolean).join(' · ')}
    onClick={launch} onKeyDown={event => {
      if (!launch || (event.key !== 'Enter' && event.key !== ' ')) return
      event.preventDefault()
      launch()
    }}>
    <span className="dchat-agent-glyph"><StateDot state={Object.hasOwn(states, agent.status) ? states[agent.status] : 'idle'} /></span>
    <span className="dchat-agent-name">
      <span>{name}</span>
      {caption && <small>{caption}</small>}
    </span>
    {status && <small className="dchat-agent-status">{status}</small>}
    <span className="dchat-agent-open" aria-hidden>
      {launch && <IconChevronRightOutlineRegular size={14} />}
    </span>
  </div>
}

function ToolLocations({ tool, openFile, t }) {
  const locations = new Map()
  const add = (rawPath, line) => {
    if (typeof rawPath !== 'string' || !rawPath) return
    const uri = fileUriReference(rawPath)
    const path = uri ? uri.path : rawPath
    const sourceLine = Number.isSafeInteger(line) && line > 0 ? line : uri?.line
    if (!locations.has(path) || sourceLine !== undefined) locations.set(path, sourceLine)
  }
  for (const location of tool.locations ?? []) add(location?.path ?? location?.uri, location?.line)
  for (const content of tool.content ?? []) {
    if (content?.type === 'diff') add(content.path)
  }
  if (Array.isArray(tool.rawInput?.paths)) tool.rawInput.paths.forEach(path => add(path))
  for (const candidate of [
    tool.rawInput?.input?.file_path, tool.rawInput?.file_path, tool.rawInput?.path,
    tool.rawInput?.TargetFile, tool.rawInput?.AbsolutePath, tool.rawInput?.Path, tool.rawInput?.uri,
  ]) add(candidate)
  if (locations.size === 0) return null
  return <ul className="dchat-tool-paths">
    {[...locations].map(([path, line]) => {
      const label = line === undefined ? path : `${path}:${line}`
      return <li key={path}><button className="dchat-tool-path" type="button" title={label}
        aria-label={t('file.open', { path: label })} onClick={() => openFile(path, { line })}>{label}</button></li>
    })}
  </ul>
}

function PermissionCard({ request, select, disabled, openFile, t }) {
  const { toolCall, options } = request
  const text = toolCall.content?.flatMap(item => {
    if (item.type === 'content' && item.content.type === 'text') return [item.content.text]
    return []
  }).join('\n')
  const detail = text || (toolCall.rawInput != null ? JSON.stringify(toolCall.rawInput, null, 2) : '')
  return <section className="dchat-approval" aria-label={t('permission.title')}>
    <h3>{t('permission.title')}</h3>
    <p>{toolCall.title || t('permission.tool')}</p>
    <ToolLocations tool={toolCall} openFile={openFile} t={t} />
    {detail && <pre>{detail}</pre>}
    <div className="dchat-approval-actions">
      {options.map(option => <Button key={option.optionId} size="sm" variant="outline" disabled={disabled}
        onClick={() => select(option.optionId)}>{option.name}</Button>)}
    </div>
  </section>
}

function UserMessage({ text, structuredReply }) {
  const replies = structuredReply && questionReply(text)
  if (replies) return <dl className="dchat-question-reply">
    {replies.map(({question,answer},i)=><div key={i}><dt>{question}</dt><dd>{answer}</dd></div>)}
  </dl>
  return text ? <p>{text}</p> : null
}

function AssistantMessage({ message, ...props }) {
  const normalized = useMemo(() => normalizeMarkdownFileUrls(message.text), [message.text])
  return normalized ? <MarkdownText text={normalized} {...props} /> : null
}

