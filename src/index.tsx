/** @jsxImportSource @opentui/solid */
import { createSignal, Show, onCleanup, createEffect, Match, Switch } from "solid-js"
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PluginOptions = {
  refreshMs?: number
  apiUrl?: string
  showRollingFiveHour?: boolean
  showWeeklyToken?: boolean
  showSearchHourly?: boolean
}

type RollingFiveHourLimit = {
  remaining: number
  max: number
  tickPercent: number
  nextTickAt: string
  limited: boolean
}

type WeeklyTokenLimit = {
  percentRemaining: number
  maxCredits: string
  remainingCredits: string
  nextRegenAt: string
  nextRegenCredits: string
}

type SearchHourlyQuota = {
  requests: number
  limit: number
  renewsAt: string
}

type QuotaData = {
  rollingFiveHourLimit: RollingFiveHourLimit
  weeklyTokenLimit: WeeklyTokenLimit
  search: {
    hourly: SearchHourlyQuota
  }
}

type QuotaState =
  | { status: "loading"; data?: QuotaData }
  | { status: "ready"; data: QuotaData }
  | { status: "error"; message: string; data?: QuotaData }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_REFRESH_MS = 15_000
const DEFAULT_REFRESH_MS = 60_000
const DEFAULT_API_URL = "https://api.synthetic.new"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRefreshMs(options: PluginOptions | undefined) {
  if (typeof options?.refreshMs !== "number" || !Number.isFinite(options.refreshMs))
    return DEFAULT_REFRESH_MS
  return Math.max(MIN_REFRESH_MS, Math.floor(options.refreshMs))
}

async function fetchQuota(apiUrl: string): Promise<QuotaData> {
  const apiKey = process.env.SYNTHETIC_API_KEY ?? ""
  if (!apiKey) throw new Error("SYNTHETIC_API_KEY not set")
  const url = `${apiUrl.replace(/\/+$/, "")}/v2/quotas`
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
  return resp.json() as Promise<QuotaData>
}

function progressBar(pctUsed: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, pctUsed))
  const filled = Math.round((clamped / 100) * width)
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled)
}

function formatCredits(credits: string): string {
  const hasDollar = credits.startsWith("$")
  const num = parseFloat(credits.replace("$", ""))
  const rounded = Math.round(num)
  return hasDollar ? `$${rounded}` : String(rounded)
}

function formatTimeUntil(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const ms = d.getTime() - Date.now()
  if (ms <= 0) return "now"
  const mins = Math.ceil(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`
}

function remainingColor(remaining: number, theme: TuiThemeCurrent) {
  if (remaining < 15) return theme.error
  if (remaining < 50) return theme.warning
  return theme.success
}

function statusColor(
  status: "NORMAL" | "WARNING" | "CRITICAL" | "LIMITED",
  theme: TuiThemeCurrent,
) {
  switch (status) {
    case "LIMITED":
    case "CRITICAL":
      return theme.error
    case "WARNING":
      return theme.warning
    case "NORMAL":
      return theme.success
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// ---------------------------------------------------------------------------
// RollingFiveHourPanel
// ---------------------------------------------------------------------------

function RollingFiveHourPanel(props: {
  api: Parameters<TuiPlugin>[0]
  state: () => QuotaState
  sessionID: string
}) {
  const [collapsed, setCollapsed] = createSignal(false)
  const theme = () => props.api.theme.current
  const toggleCollapsed = () => setCollapsed((v) => !v)
  const data = () => props.state().data?.rollingFiveHourLimit

  return (
    <box flexDirection="column" gap={0}>
      <box
        focusable
        onMouseDown={toggleCollapsed}
        onKeyDown={(event: { name: string; preventDefault: () => void }) => {
          if (event.name === "return" || event.name === "space") {
            event.preventDefault()
            toggleCollapsed()
          }
        }}
      >
        <text fg={theme().text}>
          <b>{collapsed() ? "\u25B6" : "\u25BC"} 5h Requests</b>
        </text>
      </box>

      <Show when={!collapsed()}>
        <Switch>
          <Match when={props.state().status === "error" && !data()}>
            <text fg={theme().warning}>
              {(props.state() as { message: string }).message}
            </text>
          </Match>

          <Match when={props.state().status === "loading" && !data()}>
            <text fg={theme().textMuted}>Loading...</text>
          </Match>

          <Match when={data()}>
            {(() => {
              const d = () => data()!
              const pctRemaining = () =>
                d().max > 0 ? (d().remaining / d().max) * 100 : 100
              const pctUsed = () => 100 - pctRemaining()
              const status = () =>
                d().limited
                  ? "LIMITED" as const
                  : pctRemaining() <= 10
                    ? "CRITICAL" as const
                    : pctRemaining() <= 30
                      ? "WARNING" as const
                      : "NORMAL" as const

              return (
                <box flexDirection="column" gap={0}>
                  <Show
                    when={!d().limited}
                    fallback={
                      <text fg={theme().error}> LIMITED</text>
                    }
                  >
                    <box flexDirection="row" gap={0}>
                      <text fg={theme().textMuted}>Remaining: </text>
                      <text fg={remainingColor(pctRemaining(), theme())}>
                        {Math.round(pctRemaining())}%{" "}
                        {progressBar(pctRemaining())}
                      </text>
                    </box>
                    <box flexDirection="row" gap={0}>
                      <text fg={theme().textMuted}>Credits: </text>
                      <text fg={theme().text}>
                        {Math.round(d().remaining)} / {Math.round(d().max)}
                      </text>
                    </box>
                  </Show>

                  <Show when={status() !== "NORMAL"}>
                    <text fg={statusColor(status(), theme())}>
                      {" "}{status()}
                    </text>
                  </Show>

                  <Show when={d().nextTickAt}>
                    <box flexDirection="row" gap={0}>
                      <text fg={theme().textMuted}>Next tick: </text>
                      <text fg={theme().text}>
                        {formatTimeUntil(d().nextTickAt)}
                      </text>
                    </box>
                  </Show>
                </box>
              )
            })()}
          </Match>
        </Switch>

        <Show when={props.state().status === "error" && data()}>
          <text fg={theme().warning}>
            refresh failed: {(props.state() as { message: string }).message}
          </text>
        </Show>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// WeeklyTokenPanel
// ---------------------------------------------------------------------------

function WeeklyTokenPanel(props: {
  api: Parameters<TuiPlugin>[0]
  state: () => QuotaState
  sessionID: string
}) {
  const [collapsed, setCollapsed] = createSignal(false)
  const theme = () => props.api.theme.current
  const toggleCollapsed = () => setCollapsed((v) => !v)
  const data = () => props.state().data?.weeklyTokenLimit

  return (
    <box flexDirection="column" gap={0}>
      <box
        focusable
        onMouseDown={toggleCollapsed}
        onKeyDown={(event: { name: string; preventDefault: () => void }) => {
          if (event.name === "return" || event.name === "space") {
            event.preventDefault()
            toggleCollapsed()
          }
        }}
      >
        <text fg={theme().text}>
          <b>{collapsed() ? "\u25B6" : "\u25BC"} Weekly Tokens</b>
        </text>
      </box>

      <Show when={!collapsed()}>
        <Switch>
          <Match when={props.state().status === "error" && !data()}>
            <text fg={theme().warning}>
              {(props.state() as { message: string }).message}
            </text>
          </Match>

          <Match when={props.state().status === "loading" && !data()}>
            <text fg={theme().textMuted}>Loading...</text>
          </Match>

          <Match when={data()}>
            {(() => {
              const d = () => data()!
              const pctRemaining = () => d().percentRemaining
              const pctUsed = () => 100 - pctRemaining()
              const status = () =>
                pctRemaining() <= 10
                  ? "CRITICAL" as const
                  : pctRemaining() <= 30
                    ? "WARNING" as const
                    : "NORMAL" as const

              return (
                <box flexDirection="column" gap={0}>
                  <box flexDirection="row" gap={0}>
                    <text fg={theme().textMuted}>Remaining: </text>
                    <text fg={remainingColor(pctRemaining(), theme())}>
                      {Math.round(pctRemaining())}%{" "}
                        {progressBar(pctRemaining())}
                    </text>
                  </box>
                  <box flexDirection="row" gap={0}>
                    <text fg={theme().textMuted}>Credits: </text>
                    <text fg={theme().text}>
                      {formatCredits(d().remainingCredits)} / {formatCredits(d().maxCredits)}
                    </text>
                  </box>

                  <Show when={status() !== "NORMAL"}>
                    <text fg={statusColor(status(), theme())}>
                      {" "}{status()}
                    </text>
                  </Show>

                  <Show when={d().nextRegenAt}>
                    <box flexDirection="row" gap={0}>
                      <text fg={theme().textMuted}>Next regen: </text>
                      <text fg={theme().text}>
                        {formatTimeUntil(d().nextRegenAt)}
                        {d().nextRegenCredits
                          ? ` (+${d().nextRegenCredits})`
                          : ""}
                      </text>
                    </box>
                  </Show>
                </box>
              )
            })()}
          </Match>
        </Switch>

        <Show when={props.state().status === "error" && data()}>
          <text fg={theme().warning}>
            refresh failed: {(props.state() as { message: string }).message}
          </text>
        </Show>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// SearchHourlyPanel
// ---------------------------------------------------------------------------

function SearchHourlyPanel(props: {
  api: Parameters<TuiPlugin>[0]
  state: () => QuotaState
  sessionID: string
}) {
  const [collapsed, setCollapsed] = createSignal(false)
  const theme = () => props.api.theme.current
  const toggleCollapsed = () => setCollapsed((v) => !v)
  const data = () => props.state().data?.search?.hourly

  return (
    <box flexDirection="column" gap={0}>
      <box
        focusable
        onMouseDown={toggleCollapsed}
        onKeyDown={(event: { name: string; preventDefault: () => void }) => {
          if (event.name === "return" || event.name === "space") {
            event.preventDefault()
            toggleCollapsed()
          }
        }}
      >
        <text fg={theme().text}>
          <b>{collapsed() ? "\u25B6" : "\u25BC"} Search Hourly</b>
        </text>
      </box>

      <Show when={!collapsed()}>
        <Switch>
          <Match when={props.state().status === "error" && !data()}>
            <text fg={theme().warning}>
              {(props.state() as { message: string }).message}
            </text>
          </Match>

          <Match when={props.state().status === "loading" && !data()}>
            <text fg={theme().textMuted}>Loading...</text>
          </Match>

          <Match when={data()}>
            {(() => {
              const d = () => data()!
              const pctUsed = () =>
                d().limit > 0 ? (d().requests / d().limit) * 100 : 0
              const pctRemaining = () => 100 - pctUsed()
              const status = () =>
                pctUsed() >= 90
                  ? "CRITICAL" as const
                  : pctUsed() >= 70
                    ? "WARNING" as const
                    : "NORMAL" as const

              return (
                <box flexDirection="column" gap={0}>
                  <box flexDirection="row" gap={0}>
                    <text fg={theme().textMuted}>Remaining: </text>
                    <text fg={remainingColor(pctRemaining(), theme())}>
                      {Math.round(pctRemaining())}% {progressBar(pctRemaining())}
                    </text>
                  </box>
                  <box flexDirection="row" gap={0}>
                    <text fg={theme().textMuted}>Requests: </text>
                    <text fg={theme().text}>
                      {Math.round(d().requests)} / {Math.round(d().limit)}
                    </text>
                  </box>

                  <Show when={status() !== "NORMAL"}>
                    <text fg={statusColor(status(), theme())}>
                      {" "}{status()}
                    </text>
                  </Show>

                  <Show when={d().renewsAt}>
                    <box flexDirection="row" gap={0}>
                      <text fg={theme().textMuted}>Resets: </text>
                      <text fg={theme().text}>
                        {formatTimeUntil(d().renewsAt)}
                      </text>
                    </box>
                  </Show>
                </box>
              )
            })()}
          </Match>
        </Switch>

        <Show when={props.state().status === "error" && data()}>
          <text fg={theme().warning}>
            refresh failed: {(props.state() as { message: string }).message}
          </text>
        </Show>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

const tui: TuiPlugin = async (api, options) => {
  const refreshMs = getRefreshMs(options as PluginOptions | undefined)
  const apiUrl =
    (options as PluginOptions | undefined)?.apiUrl ?? DEFAULT_API_URL
  const showRollingFiveHour =
    (options as PluginOptions | undefined)?.showRollingFiveHour ?? true
  const showWeeklyToken =
    (options as PluginOptions | undefined)?.showWeeklyToken ?? true
  const showSearchHourly =
    (options as PluginOptions | undefined)?.showSearchHourly ?? true

  const [state, setState] = createSignal<QuotaState>({ status: "loading" })

  let disposed = false
  let running = false
  let queued = false

  const refresh = async () => {
    if (running) {
      queued = true
      return
    }
    running = true
    try {
      const data = await fetchQuota(apiUrl)
      if (!disposed) setState({ status: "ready", data })
    } catch (error) {
      if (!disposed) {
        const previous = state().data
        setState({
          status: "error",
          message: errorMessage(error),
          ...(previous ? { data: previous } : {}),
        })
      }
    } finally {
      running = false
      if (queued && !disposed) {
        queued = false
        void refresh()
      }
    }
  }

  // Periodic refresh
  const interval = setInterval(() => void refresh(), refreshMs)

  // Refresh on session idle
  const stopIdle = api.event.on("session.idle", () => void refresh())

  onCleanup(() => {
    disposed = true
    clearInterval(interval)
    stopIdle()
  })

  // Initial fetch
  void refresh()

  // Rolling 5-Hour panel
  if (showRollingFiveHour) {
    api.slots.register({
      order: 150,
      slots: {
        sidebar_content(_ctx, props) {
          return (
            <RollingFiveHourPanel
              api={api}
              state={state}
              sessionID={props.session_id}
            />
          )
        },
      },
    })
  }

  // Weekly Token panel
  if (showWeeklyToken) {
    api.slots.register({
      order: 160,
      slots: {
        sidebar_content(_ctx, props) {
          return (
            <WeeklyTokenPanel
              api={api}
              state={state}
              sessionID={props.session_id}
            />
          )
        },
      },
    })
  }

  // Search Hourly panel
  if (showSearchHourly) {
    api.slots.register({
      order: 170,
      slots: {
        sidebar_content(_ctx, props) {
          return (
            <SearchHourlyPanel
              api={api}
              state={state}
              sessionID={props.session_id}
            />
          )
        },
      },
    })
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id: "synthetic-usage",
  tui,
}

export default plugin
