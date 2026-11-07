import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { QuotaSplitRpc } from "./rpc"

const GREY = "#9ea0a6"
const AMBER = "#e5a04d"
const RED = "#e5484d"

type Win = { spent: number; limit: number }
type AccountWin = { percent: number; resetAt: string }
type Usage = {
  provider: string
  windows: { h5: Win; d7: Win; d30: Win }
  account?: { h5: AccountWin; d7: AccountWin; d30: AccountWin }
}

const ORDER: Array<{ id: "h5" | "d7" | "d30"; label: string }> = [
  { id: "h5", label: "5h" },
  { id: "d7", label: "7d" },
  { id: "d30", label: "30d" },
]

export default Plugin.define({
  id: "quota-split.tui",
  async setup(context: any) {
    if (context.options?.tui === false) return
    const rpc = context.client.rpc(QuotaSplitRpc)
    const [usage, setUsage] = createSignal<Usage | null>(null)

    const refresh = async () => {
      try {
        setUsage(await rpc.usage({}))
      } catch {
        /* server part may still be loading */
      }
    }
    await refresh()
    const unsub = rpc.events.on("updated", () => void refresh())

    const worst = (u: Usage | null) => {
      if (!u) return 0
      let max = 0
      for (const w of ORDER) {
        const win = u.windows[w.id]
        if (win?.limit > 0) max = Math.max(max, win.spent / win.limit)
      }
      return max
    }

    const color = (u: Usage | null) => {
      const r = worst(u)
      return r >= 1 ? RED : r >= 0.8 ? AMBER : GREY
    }

    const label = (u: Usage | null) => {
      if (!u) return "Go —"
      let best = ORDER[0]
      let max = -1
      for (const w of ORDER) {
        const win = u.windows[w.id]
        const ratio = win && win.limit > 0 ? win.spent / win.limit : 0
        if (ratio > max) {
          max = ratio
          best = w
        }
      }
      return `Go ${best.label} ${Math.round(Math.max(0, max) * 100)}%`
    }

    const detail = async () => {
      await refresh()
      const u = usage()
      if (!u) {
        context.ui.toast.show({ title: "Quota split", message: "Данные ещё не загружены", variant: "error", duration: 3000 })
        return
      }
      const lines = ORDER.map((w) => {
        const win = u.windows[w.id]
        const pct = win.limit > 0 ? Math.min(100, (win.spent / win.limit) * 100) : 0
        const state = win.spent >= win.limit ? " — ЛИМИТ, промпты блокируются" : ""
        return `${w.label}: $${win.spent.toFixed(4)} из $${win.limit.toFixed(2)} (${pct.toFixed(1)}%)${state}`
      })
      if (u.account) {
        lines.push(
          "",
          `Аккаунт: 5ч ${u.account.h5.percent.toFixed(0)}% · 7д ${u.account.d7.percent.toFixed(0)}% · 30д ${u.account.d30.percent.toFixed(0)}%`,
        )
      }
      await context.ui.dialog.alert({
        title: "OpenCode Go — локальный сплит",
        message:
          `${lines.join("\n")}\n\nПровайдер: ${u.provider}\n` +
          `Считается только этот провайдер, окна скользящие.\n` +
          `Лимиты: opencode.jsonc → plugins → quota-split → options.limits`,
      })
    }

    const widgets = [
      context.ui.slot({
        append: "prompt.footer.status",
        render: () => <text fg={color(usage())}>{label(usage())}</text>,
      }),
    ]

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "quotasplit.detail",
          title: "Показать окна Go: 5ч / 7д / 30д",
          group: "Quota split",
          palette: true,
          slash: { name: "quota_split", aliases: ["split", "golimit"] },
          enabled: () => true,
          run: async () => {
            await detail()
          },
        },
      ],
    }))

    const timer = setInterval(() => void refresh(), 60_000)

    return () => {
      unsub()
      clearInterval(timer)
      for (const s of widgets) {
        try {
          if (typeof s === "function") s()
        } catch {
          /* noop */
        }
      }
    }
  },
})
