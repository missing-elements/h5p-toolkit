/**
 * cmi5 for `<h5p-player>`: `startCmi5(player)` makes a page holding the element a cmi5 unit.
 * Nothing is sent on unload (a reload looks like a close, and `terminated` ends the live session).
 */

import { createCmi5Client, launchParametersOf, reasonIn } from './client.js'
import { ReadyPhase } from './ready-phase.js'
import { adaptPlayerStatement, allowedStatement as adaptAllowedStatement } from './statement-adapter.js'

export { Cmi5RequestError, createCmi5Client, isoDuration, judge, launchParametersOf, type Cmi5ClientOptions } from './client.js'

/* ------------------------------------------------------------------ types */

/** An xAPI statement, as the element dispatches it and the LRS receives it. */
export type Statement = Record<string, any>

/** The five parameters an LMS appends to the assignable unit's URL. */
export interface LaunchParameters {
  endpoint: string
  fetch: string
  actor: Record<string, unknown>
  registration: string
  activityId: string
}

/** The `LMS.LaunchData` state document the LMS writes before the launch. */
export interface LaunchData {
  contextTemplate?: Record<string, any>
  launchMode: 'Normal' | 'Browse' | 'Review'
  moveOn: 'Passed' | 'Completed' | 'CompletedAndPassed' | 'CompletedOrPassed' | 'NotApplicable'
  masteryScore?: number
  returnURL?: string
  launchParameters?: string
  launchMethod?: 'OwnWindow' | 'AnyWindow'
}

/** The `cmi5LearnerPreferences` agent profile: what the learner set in the LMS, when they set it. */
export interface LearnerPreferences {
  languagePreference?: string
  audioPreference?: 'on' | 'off'
}

/**
 * What earlier sessions of this registration recorded, read from the LRS on `initialize`. With
 * `unread`, the LRS would not say, and the two flags only count this session.
 */
export interface RegistrationHistory {
  completed: boolean
  passed: boolean
  unread?: string
}

/** A score as cmi5 records it: `min` and `max` are required beside `raw`. */
export interface Cmi5Score {
  scaled: number
  raw?: number
  min?: number
  max?: number
}

/** What `moveOn()` sent to the LRS in this call. */
export interface MoveOnResult {
  outcome: 'passed' | 'failed' | null
  completed: boolean
}

/** A cmi5 client, as `createCmi5Client` makes one. Another one — a simulated LMS, a test double — can be passed as `client`. */
export interface Cmi5Client {
  getLaunchParameters(): LaunchParameters
  getLaunchData(): LaunchData
  getAuthToken(): string
  getInitializedDate(): Date
  /** The learner's preferences, read on `initialize`; a client without them reports none. */
  getLearnerPreferences?(): LearnerPreferences
  /** What the registration already holds; a client without it leaves `moveOn` to decide alone. */
  getRegistrationHistory?(): RegistrationHistory
  initialize(state?: { authToken: string; initializedDate: Date }): Promise<unknown>
  sendXapiStatement(statement: Statement): Promise<unknown>
  /**
   * `passed` or `failed`, then `completed`, then `terminated` unless disabled. `success` is the
   * content's own verdict, used when the launch has no mastery score.
   */
  moveOn(options: { score?: Cmi5Score; success?: boolean; disableSendTerminated?: boolean }): Promise<MoveOnResult>
  terminate(): Promise<unknown>
}

/** What happened, for a host that shows or logs it. */
export type Cmi5Event =
  | {
      type: 'initialized'
      /** A reload picked the session up; nothing was sent. */
      resumed: boolean
      launchParameters: LaunchParameters
      launchData: LaunchData
      /** What the learner set in the LMS; `audioPreference` is the page's to apply. */
      learnerPreferences: LearnerPreferences
      /** The address Exit goes to, or null. */
      returnURL: string | null
    }
  | { type: 'sent'; verb: string; statement: Statement }
  | { type: 'rejected'; verb: string; reason: string; statement?: Statement }
  | {
      type: 'recorded'
      /** `passed` or `failed` went out now; null when there was no mastery score, or the registration had passed. */
      outcome: 'passed' | 'failed' | null
      /** `completed` went out now; false when an earlier session of the registration sent it. */
      completed: boolean
    }
  | {
      type: 'registration-unread'
      /** Why the LRS did not say what earlier sessions recorded; `completed` and `passed` are then kept once per session only. */
      reason: string
    }
  | { type: 'skipped'; reason: string }
  | { type: 'terminated' }
  | { type: 'unsafe-return-url'; value: string }
  /** A package named by the address or the launch that is not an http or https address: not played. */
  | { type: 'unsafe-src'; value: string }

/** The element, or anything that dispatches its `xapi` and `finished` events and takes `src`. */
export type PlayerLike = Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & {
  setAttribute(name: string, value: string): void
}

/** Where the per-launch session is kept; `null` by default. */
export type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface Cmi5Options {
  /** The cmi5 client; by default `createCmi5Client` on the launch in `url`. */
  client?: Cmi5Client
  /**
   * The package to play: the address's `src`, then the launch data's `launchParameters`; `false`
   * leaves the element's `src` alone. Only http(s) reaches the element, else `unsafe-src`.
   */
  src?: string | false
  /** The page's address, for `src`; `location.href` by default. */
  url?: string
  /** Where the session is kept across a reload; `null` by default. */
  storage?: SessionStorage | null
  /** Told about each step. Called synchronously; a throw in it is ignored. */
  onEvent?: (event: Cmi5Event) => void
}

export interface Cmi5Session {
  readonly launchParameters: LaunchParameters
  readonly launchData: LaunchData
  /** The learner's language and audio preferences, from the LMS; empty when none were set. */
  readonly learnerPreferences: LearnerPreferences
  /** A reload picked this session up. */
  readonly resumed: boolean
  /** The package the element was given, as an absolute address; null when neither the address nor the launch named one it plays. */
  readonly src: string | null
  /** The launch data's `returnURL`, when it is an http or https address. */
  readonly returnURL: string | null
  readonly terminated: boolean
  /** Sends `terminated` once; nothing is relayed after it. */
  terminate(): Promise<void>
  /** Retries a completion outcome that the LRS did not accept. */
  retry(): Promise<void>
  /**
   * `terminate()`, then the return URL. With none, it closes the window, if the page is top level;
   * a frame cannot close the LMS page around it, so a framed page stays where it is.
   */
  exit(): Promise<void>
  /** Stops listening to the element, without terminating. */
  stop(): void
}

/* ------------------------------------------------------------------ pure parts */

/** Whether this address is a cmi5 launch: all five parameters are there, the actor as JSON. */
export function isCmi5Launch(url: string = globalThis.location?.href ?? ''): boolean {
  return launchParametersOf(url) !== null
}

/**
 * The content's statement as cmi5 allows it: launch actor, registration and the LMS's context
 * template (it wins). No cmi5 category (it marks cmi5-defined ones); a UUID id (9.1.0.0-1).
 */
export { adaptAllowedStatement as allowedStatement }

/**
 * An H5P score as cmi5 records it: `min` and `max` are required beside `raw` (9.5.1.0-3), and
 * H5P's minimum is 0. Undefined when there is nothing to scale.
 */
export function cmi5Score(score: Statement | undefined | null): Cmi5Score | undefined {
  if (!score) return undefined
  const scaled = typeof score.scaled === 'number' ? score.scaled : typeof score.raw === 'number' && score.max ? score.raw / score.max : undefined
  if (scaled === undefined) return undefined
  const hasRange = typeof score.raw === 'number' && typeof score.max === 'number'
  return { scaled, ...(hasRange ? { raw: score.raw, min: typeof score.min === 'number' ? score.min : 0, max: score.max } : {}) }
}

/**
 * An absolute http or https address, or null: a `javascript:` return URL would run in the page.
 * With `base`, a relative address is resolved against it.
 */
export function webAddress(value: unknown, base?: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim(), base)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/** What went wrong, as the LMS said it: a cmi5 launching system names the requirement a statement broke. */
export function rejectionReason(error: unknown): string {
  // `response.data` as the client's own error and the axios-shaped one a host's client may
  // throw both carry it; `reasonIn` is the one reading of what it says.
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data
  const reason = reasonIn(data)
  if (reason) return reason
  if (data && typeof data === 'object') return JSON.stringify(data)
  return error instanceof Error ? error.message : String(error)
}

const verbOf = (statement: Statement | undefined): string => {
  const id: string = statement?.verb?.id ?? ''
  return id.slice(id.lastIndexOf('/') + 1) || '(no verb)'
}

/* ------------------------------------------------------------------ the session kept across a reload */

/**
 * The storage key is the `fetch` URL alone, so a record also names its launch: one for another
 * endpoint, registration or activity is ignored, not handed its token on to the LRS.
 */
interface KeptLaunch {
  endpoint: string
  registration: string
  activityId: string
}

interface KeptSession extends KeptLaunch {
  authToken: string
  initializedDate: Date
  movedOn: boolean
  pendingOutcome?: Outcome
}

interface Outcome {
  score?: Cmi5Score
  success?: boolean
}

function readKept(storage: SessionStorage | null, key: string, launch: KeptLaunch): KeptSession | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const { authToken, initializedDate, movedOn, pendingOutcome, endpoint, registration, activityId } = JSON.parse(raw)
    if (!authToken || !initializedDate) return null
    if (endpoint !== launch.endpoint || registration !== launch.registration || activityId !== launch.activityId) return null
    return {
      ...launch,
      authToken,
      initializedDate: new Date(initializedDate),
      movedOn: Boolean(movedOn),
      ...(pendingOutcome ? { pendingOutcome } : {})
    }
  } catch {
    // A storage that cannot be read, or holds something that is not a session, keeps nothing:
    // the launch starts afresh, as it would without `storage` at all.
    return null
  }
}

function writeKept(storage: SessionStorage | null, key: string, value: KeptSession): void {
  try {
    storage?.setItem(key, JSON.stringify(value))
  } catch {
    // Not kept — a full or refused storage, a private window — and the session goes on from
    // memory, which is the default; a reload then starts the launch afresh.
  }
}

function forgetKept(storage: SessionStorage | null, key: string): void {
  try {
    storage?.removeItem(key)
  } catch {
    // What could not be written cannot be read back either; nothing is left behind to forget.
  }
}

/* ------------------------------------------------------------------ the session */

/**
 * Starts the session for this launch around the element. It listens at once, as the package loads
 * meanwhile, and holds what is emitted before `initialized` until it is out.
 */
export async function startCmi5(player: PlayerLike, options: Cmi5Options = {}): Promise<Cmi5Session> {
  const emit = (event: Cmi5Event) => {
    try {
      options.onEvent?.(event)
    } catch {}
  }
  const url = options.url ?? globalThis.location?.href ?? ''
  // H5P libraries run in a same-origin frame, so browser storage would expose an LRS token to
  // package code. A host must explicitly opt in when it can protect its chosen storage.
  const storage = options.storage ?? null

  let data: LaunchData | null = null
  let launch: LaunchParameters | null = null
  let client: Cmi5Client | null = null
  let terminated = false
  let termination: Promise<void> | null = null
  let movedOn = false
  let recording = false
  let kept: KeptSession | null = null
  let key = ''
  const readyPhase = new ReadyPhase<Statement, Outcome>()
  let pendingOutcome: Outcome | null = null

  const send = async (statement: Statement) => {
    if (terminated || !client) return
    try {
      await client.sendXapiStatement(statement)
      emit({ type: 'sent', verb: verbOf(statement), statement })
    } catch (error) {
      emit({ type: 'rejected', verb: verbOf(statement), reason: rejectionReason(error), statement })
    }
  }

  const relay = (statement: Statement) => {
    if (!statement) return
    const readyStatement = readyPhase.statement(statement)
    if (readyStatement) sendPlayerStatement(readyStatement)
  }

  const sendPlayerStatement = (statement: Statement) => {
    if (!launch || !data) return
    const adapted = adaptPlayerStatement(statement, launch, data)
    if ('reason' in adapted) {
      emit({ type: 'rejected', verb: verbOf(statement), reason: adapted.reason, statement })
      return
    }
    void send(adapted.statement)
  }

  /**
   * The content finished: the outcome, the cmi5 way. Once per session, reloads included, and
   * once per registration as far as the LRS says: what an earlier session sent is not sent again.
   */
  const record = async () => {
    if (!client || !data || !pendingOutcome || movedOn || recording || terminated) return
    recording = true
    if (data.launchMode !== 'Normal') {
      emit({ type: 'skipped', reason: `nothing is recorded in ${data.launchMode} mode` })
      recording = false
      return
    }
    const { score, success } = pendingOutcome
    try {
      // `terminated` is left for the host's Exit, so the learner can keep going.
      const result = await client.moveOn({ ...(score ? { score } : {}), ...(success === undefined ? {} : { success }), disableSendTerminated: true })
      movedOn = true
      pendingOutcome = null
      keepMovedOn()
      if (!result.outcome && !result.completed) {
        emit({ type: 'skipped', reason: 'this registration already recorded its result in an earlier session' })
      } else {
        emit({ type: 'recorded', ...result })
      }
    } catch (error) {
      emit({ type: 'rejected', verb: 'move-on', reason: rejectionReason(error) })
    } finally {
      recording = false
    }
  }

  const keepMovedOn = () => {
    if (!kept) return
    kept = { ...kept, movedOn: true, pendingOutcome: undefined }
    writeKept(storage, key, kept)
  }

  const keepPendingOutcome = () => {
    if (!kept || !pendingOutcome) return
    kept = { ...kept, pendingOutcome }
    writeKept(storage, key, kept)
  }

  const onXapi = (event: Event) => relay((event as CustomEvent).detail?.statement)
  const onFinished = (event: Event) => {
    const detail = (event as CustomEvent).detail
    const result = detail?.statement?.result
    const score = cmi5Score(result?.score)
    const outcome: Outcome = {
      ...(score ? { score } : {}),
      ...(typeof result?.success === 'boolean' ? { success: result.success as boolean } : {})
    }
    const readyOutcome = readyPhase.outcome(outcome)
    if (!readyOutcome) return
    pendingOutcome = readyOutcome
    keepPendingOutcome()
    void record()
  }
  player.addEventListener('xapi', onXapi)
  player.addEventListener('finished', onFinished)
  const stop = () => {
    player.removeEventListener('xapi', onXapi)
    player.removeEventListener('finished', onFinished)
    readyPhase.stop()
  }

  /** The package as the element is given it, resolved against the page's address; anything else is reported. */
  const playable = (value: string) => {
    const address = webAddress(value, url || undefined)
    if (!address) emit({ type: 'unsafe-src', value })
    return address
  }

  let src: string | null = null
  if (options.src !== false) {
    const named = options.src ?? readSrc(url)
    src = named ? playable(named) : null
    if (src) player.setAttribute('src', src)
  }

  try {
    client = options.client ?? createCmi5Client({ url })
    launch = client.getLaunchParameters()
    key = `h5p-cmi5:${launch.fetch}`
    const bound: KeptLaunch = { endpoint: launch.endpoint, registration: launch.registration, activityId: launch.activityId }
    const saved = readKept(storage, key, bound)
    movedOn = Boolean(saved?.movedOn)
    await client.initialize(saved ? { authToken: saved.authToken, initializedDate: saved.initializedDate } : undefined)
    data = client.getLaunchData()
    kept = saved ?? { ...bound, authToken: client.getAuthToken(), initializedDate: client.getInitializedDate(), movedOn: false }
    if (!saved) writeKept(storage, key, kept)

    const returnURL = webAddress(data.returnURL)
    if (data.returnURL && !returnURL) emit({ type: 'unsafe-return-url', value: data.returnURL })

    if (options.src !== false && !src) {
      const fromLaunch = data.launchParameters?.trim()
      if (fromLaunch) {
        src = playable(fromLaunch)
        if (src) player.setAttribute('src', src)
      }
    }

    const learnerPreferences = client.getLearnerPreferences?.() ?? {}
    const unread = client.getRegistrationHistory?.().unread
    if (unread) emit({ type: 'registration-unread', reason: unread })
    emit({ type: 'initialized', resumed: Boolean(saved), launchParameters: launch, launchData: data, learnerPreferences, returnURL })
    const boundClient = client
    const boundLaunch = launch
    const boundData = data

    const buffered = readyPhase.ready()
    pendingOutcome = saved?.pendingOutcome ?? buffered.outcome ?? pendingOutcome
    for (const statement of buffered.statements) sendPlayerStatement(statement)
    if (pendingOutcome) void record()

    const terminate = (): Promise<void> => {
      if (terminated) return Promise.resolve()
      if (termination) return termination
      termination = boundClient.terminate().then(
        () => {
          terminated = true
          forgetKept(storage, key)
          stop()
          emit({ type: 'terminated' })
        },
        (error) => {
          emit({ type: 'rejected', verb: 'terminated', reason: rejectionReason(error) })
          throw error
        }
      ).finally(() => {
        if (!terminated) termination = null
      })
      return termination
    }

    return {
      launchParameters: boundLaunch,
      launchData: boundData,
      learnerPreferences,
      resumed: Boolean(saved),
      src,
      returnURL,
      get terminated() {
        return terminated
      },
      terminate,
      retry: record,
      async exit() {
        await terminate()
        if (returnURL) globalThis.location?.assign(returnURL)
        else if (globalThis.top === globalThis.self) globalThis.close?.()
      },
      stop
    }
  } catch (error) {
    stop()
    throw new Error(rejectionReason(error))
  }
}

function readSrc(url: string): string | null {
  try {
    return new URL(url).searchParams.get('src')?.trim() || null
  } catch {
    return null
  }
}
