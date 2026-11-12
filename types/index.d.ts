/** One prompt waiting in the /after queue. */
export type AfterItem = { id: string; text: string; addedAt: number }

/** What the band shows: why the queue is still waiting, or that it is about to fire. */
export type AfterStatus = { waiting: string[]; settling: boolean }

/** A model turn that has started and not yet completed. */
export type AfterTurn = { turnId: string; agentId: string | null }

/**
 * What the mod knows about the work in flight. Kept in $.state so a reload of
 * the mod mid-work does not forget a running turn.
 */
export type AfterTracker = {
  mainTurns: string[]
  agentTurns: AfterTurn[]
  /** The last main turn ended normally (not interrupted, no API error). */
  lastEndOk: boolean
  /** A prompt this mod submitted has not had its main turn end yet. */
  awaitingEnd: boolean
}

declare module 'claude-code' {
  interface PluginState {
    after: {
      queue: Shaped<AfterItem[]>
      status: AfterStatus
      paused: boolean
      /** The id of the item being edited in the prompt box; it is held meanwhile. */
      editing: string | null
      tracker: Shaped<AfterTracker>
    }
  }
}
