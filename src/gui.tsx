/** GUI half of quota-split — OpenCode Desktop: header ring + Console-style panel. */
import { Command, Panel, Plugin, Slot, type PanelTab } from "@opencode/plugin/gui"
import { createSignal } from "solid-js"
import { QuotaSplitRpc } from "../rpc"

type Win = { spent: number; limit: number }
type AccountWin = { percent: number; resetAt: string }
type Usage = {
  provider: string
  windows: { h5: Win; d7: Win; d30: Win }
  account?: { h5: AccountWin; d7: AccountWin; d30: AccountWin }
}

const ROWS: Array<{ id: "h5" | "d7" | "d30"; label: string }> = [
  { id: "h5", label: "5-hour window" },
  { id: "d7", label: "Weekly" },
  { id: "d30", label: "Monthly" },
]

const REFRESH_MS = 60_000
const GREEN = "#3fb950"
const AMBER = "#d29922"
const RED = "#f85149"

let ACCENT = "white"

function accentColor(): string {
  switch (ACCENT) {
    case "purple":
      return "#a78bfa"
    case "blue":
      return "#60a5fa"
    case "green":
      return GREEN
    case "amber":
      return AMBER
    default:
      return "currentColor"
  }
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n))
}

function tint(value: number): string {
  if (value >= 100) return RED
  if (value >= 80) return AMBER
  return accentColor()
}

function left(iso: string | undefined): string {
  if (!iso) return "—"
  const ms = Date.parse(iso) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return "—"
  const total = Math.floor(ms / 60_000)
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const minutes = total % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function percentOf(u: Usage | undefined, id: "h5" | "d7" | "d30"): number {
  if (!u) return 0
  const local = u.windows[id]
  if (local && local.limit > 0) return clamp((local.spent / local.limit) * 100)
  const acc = u.account?.[id]
  return acc ? clamp(acc.percent) : 0
}

function ProgressCircle(props: {
  percentage: number
  appearance?: "compact" | "indicator"
  size?: number
  strokeWidth?: number
  color?: string
}) {
  const appearance = props.appearance ?? "compact"
  const viewBox = appearance === "indicator" ? 16 : 14
  const size = props.size ?? viewBox
  const stroke = props.strokeWidth ?? (appearance === "indicator" ? 3 : 1.5)
  const center = viewBox / 2
  const radius = center - stroke / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - clamp(props.percentage) / 100)
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${viewBox} ${viewBox}`}
      fill="none"
      style={{ display: "block", transform: "rotate(-90deg)" }}
    >
      <circle
        cx={center}
        cy={center}
        r={radius}
        stroke="var(--v2-background-bg-layer-04)"
        stroke-width={stroke}
      />
      {appearance === "indicator" ? (
        <circle
          cx={center}
          cy={center}
          r={radius}
          stroke="var(--v2-overlay-simple-overlay-pressed, transparent)"
          stroke-width={stroke}
        />
      ) : null}
      <circle
        cx={center}
        cy={center}
        r={radius}
        stroke={props.color ?? "var(--v2-icon-icon-base)"}
        stroke-width={stroke}
        stroke-dasharray={circumference.toString()}
        stroke-dashoffset={offset.toString()}
        style={{ transition: "stroke-dashoffset 0.35s cubic-bezier(0.65, 0, 0.35, 1)" }}
      />
    </svg>
  )
}

function Ring(props: { value: number; onClick: () => void }) {
  const accent = ACCENT === "white" ? "var(--v2-icon-icon-base)" : accentColor()
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => props.onClick()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") props.onClick()
      }}
      title="Go limits — open or close the panel"
      style={{
        width: "16px",
        height: "16px",
        display: "grid",
        "place-items": "center",
        cursor: "pointer",
        "flex-shrink": "0",
        opacity: "0.9",
      }}
    >
      <ProgressCircle appearance="indicator" percentage={clamp(props.value)} size={16} color={accent} />
    </div>
  )
}

function MeterRow(props: { label: string; percent: number; resetAt?: string }) {
  const value = () => clamp(props.percent)
  const color = () => tint(value())
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "7px",
        padding: "14px 16px",
        "border-top": "1px solid color-mix(in srgb, currentColor 8%, transparent)",
      }}
    >
      <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
        <span style={{ "font-size": "13px", "font-weight": "600" }}>{props.label}</span>
        <span
          style={{
            "font-size": "10px",
            padding: "1px 6px",
            "border-radius": "5px",
            color: color(),
            background: `color-mix(in srgb, ${color()} 15%, transparent)`,
            "font-variant-numeric": "tabular-nums",
          }}
        >
          {value().toFixed(0)}% used
        </span>
        <span style={{ "margin-left": "auto", "font-size": "11px", opacity: "0.55" }}>
          Resets in {left(props.resetAt)}
        </span>
      </div>
      <div
        style={{
          height: "5px",
          "border-radius": "999px",
          background: "color-mix(in srgb, currentColor 12%, transparent)",
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${value()}%`, height: "100%", background: color(), "border-radius": "999px" }} />
      </div>
    </div>
  )
}

function QuotaView(props: { data: () => Usage | undefined; error: () => string | undefined }) {
  const account = () => props.data()?.account
  const renew = () => "Renews in " + left(account()?.d30?.resetAt)
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "14px", padding: "16px" }}>
      <div style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
        <div style={{ display: "flex", "align-items": "baseline", gap: "8px" }}>
          <span style={{ "font-size": "15px", "font-weight": "600" }}>Go Subscription</span>
          <span style={{ "font-size": "10px", opacity: "0.45" }}>OpenCode Go</span>
        </div>
        <div style={{ display: "flex", "align-items": "center", gap: "6px", "font-size": "11px", opacity: "0.65" }}>
          <span style={{ width: "6px", height: "6px", "border-radius": "50%", background: GREEN }} />
          {renew()}
        </div>
      </div>

      {props.error() ? <span style={{ "font-size": "11px", color: RED }}>{props.error()}</span> : null}

      <div
        style={{
          border: "1px solid color-mix(in srgb, currentColor 10%, transparent)",
          "border-radius": "10px",
          overflow: "hidden",
          background: "color-mix(in srgb, currentColor 3%, transparent)",
        }}
      >
        {ROWS.map((row) => (
          <MeterRow
            label={row.label}
            percent={percentOf(props.data(), row.id)}
            resetAt={account()?.[row.id]?.resetAt}
          />
        ))}
      </div>

      {props.data() ? (
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "3px",
            "font-size": "10px",
            opacity: "0.45",
            "font-variant-numeric": "tabular-nums",
          }}
        >
          <span>
            Твой расход ${props.data()!.windows.h5.spent.toFixed(2)} · лимиты $
            {props.data()!.windows.h5.limit} / ${props.data()!.windows.d7.limit} / $
            {props.data()!.windows.d30.limit}
          </span>
          {props.data()!.account ? (
            <span>
              Аккаунт: 5ч {props.data()!.account!.h5.percent.toFixed(0)}% · 7д{" "}
              {props.data()!.account!.d7.percent.toFixed(0)}% · 30д{" "}
              {props.data()!.account!.d30.percent.toFixed(0)}%
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const tab: PanelTab = {
  id: "quota",
  title: "Go Subscription",
  closable: "compact",
}

export default Plugin.define({
  setup(ctx) {
    ACCENT = String(ctx.options?.accent ?? "white")
    const [data, setData] = createSignal<Usage | undefined>()
    const [error, setError] = createSignal<string | undefined>()
    let stopped = false

    const load = async () => {
      try {
        const result = (await ctx.client.rpc(QuotaSplitRpc).usage({})) as Usage
        if (stopped) return
        setData(result)
        setError(undefined)
      } catch (cause) {
        if (stopped) return
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }

    const toggle = () => {
      const session = ctx.sessions.current()
      if (session) ctx.layout.toggle(`${ctx.id}:quota`, session)
      void load()
    }

    ctx.add(Panel, {
      id: "quota",
      region: "side",
      mobile: { title: "Go Subscription", order: 40, kind: "tab", icon: "status" },
      list: (input) => (input.open.includes("quota") ? [tab] : []),
      render: () => <QuotaView data={data} error={error} />,
    })

    ctx.add(Slot, {
      at: "session.header",
      order: 5,
      render: () => <Ring value={percentOf(data(), "h5")} onClick={toggle} />,
    })

    ctx.add(Command, {
      id: "toggle",
      title: "Go Subscription: открыть / закрыть",
      description: "Квоты 5ч / 7д / 30д OpenCode Go",
      keywords: "opencode go quota subscription лимит квота",
      group: "Go Subscription",
      run: toggle,
    })

    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)

    return () => {
      stopped = true
      clearInterval(timer)
    }
  },
})
