/** One prompt waiting in the /after queue. */
export type AfterItem = { id: string; text: string; addedAt: number }

/** What the band shows: why the queue is still waiting, or that it is about to fire. */
export type AfterStatus = { waiting: string[]; settling: boolean }

/** A background task as the last Stop event reported it. */
export type AfterTask = { id: string; type: string; description: string }

/** A session cron as the last Stop event reported it. */
export type AfterCron = { id: string; recurring: boolean }

/** A model turn that has started and not yet completed. */
export type AfterTurn = { turnId: string; agentId: string | null }

/**
 * What the mod knows about the work in flight. Kept in $.state so a reload of
 * the mod mid-work does not forget a running turn.
 */
export type AfterTracker = {
  mainTurns: string[]
  agentTurns: AfterTurn[]
  /** A Stop (that was not blocked) arrived since the last main turn started. */
  stopSeen: boolean
  /** The last main turn ended normally (not interrupted, no API error). */
  lastEndOk: boolean
  bgTasks: AfterTask[]
  crons: AfterCron[]
}

declare module 'claude-code' {
  interface PluginState {
    after: {
      queue: Shaped<AfterItem[]>
      status: AfterStatus
      paused: boolean
      tracker: Shaped<AfterTracker>
    }
  }
}
