import { Plugin } from "@opencode/plugin"
import { QuotaSplitRpc } from "./rpc"
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"

const DAY = 86_400_000
const WINDOWS = [
  { id: "h5", label: "5h", ms: 5 * 3_600_000, def: 10 },
  { id: "d7", label: "7d", ms: 7 * DAY, def: 25 },
  { id: "d30", label: "30d", ms: 30 * DAY, def: 50 },
] as const

type Entry = { t: number; d: number; sid?: string }
type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
type AccountWin = { percent: number; resetAt: string }
type AccountQuota = { h5: AccountWin; d7: AccountWin; d30: AccountWin }

const round = (n: number) => Math.round(n * 1e6) / 1e6

// DeepSeek V4.1 Flash, USD per 1M tokens. Peak is weekdays 01-04 and 06-10 UTC.
const PRICES = {
  off: { input: 0.15, output: 0.6, cache: 0.003 },
  peak: { input: 0.3, output: 1.2, cache: 0.006 },
}

function isPeak(ms: number): boolean {
  const d = new Date(ms)
  const day = d.getUTCDay()
  const hour = d.getUTCHours()
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
}

function tokenCost(delta: Tokens, ms: number): number {
  const p = isPeak(ms) ? PRICES.peak : PRICES.off
  return (delta.input * p.input + (delta.output + delta.reasoning) * p.output + delta.cache.read * p.cache) / 1e6
}

function tokenDelta(prev: Tokens | undefined, next: Tokens): Tokens {
  const p = prev ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  return {
    input: Math.max(0, next.input - p.input),
    output: Math.max(0, next.output - p.output),
    reasoning: Math.max(0, next.reasoning - p.reasoning),
    cache: {
      read: Math.max(0, next.cache.read - p.cache.read),
      write: Math.max(0, next.cache.write - p.cache.write),
    },
  }
}

/**
 * Local split guard for OpenCode Go.
 *
 * Counts only sessions whose model provider is `opencode-go` (default),
 * keeps a rolling log of spend deltas and blocks new prompts when a 5h / 7d /
 * 30d window reaches its configured cap.
 *
 * Limits default to half of DeepSeek V4.1 Flash: 10 / 25 / 50 USD.
 */
export default Plugin.define({
  id: "quota-split",
  async setup(ctx: any) {
    const provider = String(ctx.options?.providerID ?? "opencode-go")
    const limits: Record<string, number> = {}
    for (const w of WINDOWS) {
      const v = ctx.options?.limits?.[w.id]
      limits[w.id] = typeof v === "number" && v > 0 ? v : w.def
    }

    let entries: Entry[] = []
    let lastTokens = new Map<string, Tokens>()
    let modelOf = new Map<string, string>()
    let account: AccountQuota | undefined
    let accountAt = 0
    let refreshingAccount = false
    let stopped = false
    let providerOf = new Map<string, string>()
    let loaded = false
    let booting: Promise<void> | null = null
    let persistTimer: ReturnType<typeof setTimeout> | null = null
    let ticker: ReturnType<typeof setInterval> | null = null
    let notify: () => void = () => {}

    const prune = () => {
      const cut = Date.now() - 32 * DAY
      entries = entries.filter((e) => e.t >= cut)
    }

    const windowStart = (id: "h5" | "d7" | "d30", ms: number) => {
      const reset = account?.[id]?.resetAt ? Date.parse(account[id].resetAt) : Number.NaN
      if (Number.isFinite(reset) && reset > Date.now()) return reset - ms
      if (Number.isFinite(reset)) return Math.max(reset, Date.now() - ms)
      return Date.now() - ms
    }

    const sum = (id: "h5" | "d7" | "d30", ms: number) => {
      const from = windowStart(id, ms)
      let total = 0
      for (const e of entries) if (e.t >= from) total += e.d
      return round(total)
    }

    const snapshot = (sessionID?: string) => {
      const out: Record<string, { spent: number; limit: number }> = {}
      for (const w of WINDOWS) out[w.id] = { spent: sum(w.id, w.ms), limit: limits[w.id] }
      const spent = sessionID ? round(entries.filter((e) => e.sid === sessionID).reduce((a, e) => a + e.d, 0)) : undefined
      return {
        provider,
        windows: out,
        ...(account ? { account } : {}),
        ...(spent !== undefined ? { session: { spent } } : {}),
      }
    }

    const mergeEntries = (a: Entry[], b: Entry[]): Entry[] => {
      const merged = new Map<string, Entry>()
      for (const e of [...a, ...b]) {
        if (!Number.isFinite(e?.t) || !Number.isFinite(e?.d) || e.d < 0) continue
        merged.set(`${e.t}:${e.sid ?? ""}:${e.d}`, e)
      }
      return [...merged.values()].sort((x, y) => x.t - y.t)
    }

    const hydrate = async () => {
      try {
        const stored: any = await ctx.storage.get("entries")
        if (Array.isArray(stored)) entries = mergeEntries(stored, entries)
      } catch {
        /* no stored entries yet */
      }
      try {
        const stored: any = await ctx.storage.get("account")
        if (stored?.h5 && stored?.d7 && stored?.d30) account = stored
      } catch {
        /* no stored account yet */
      }
    }

    const persist = async () => {
      try {
        const stored: any = await ctx.storage.get("entries")
        if (Array.isArray(stored)) entries = mergeEntries(stored, entries)
      } catch {
        /* no stored entries yet */
      }
      prune()
      try {
        await ctx.storage.set("entries", entries)
        if (account) await ctx.storage.set("account", account)
      } catch {
        /* best effort */
      }
    }

    const schedulePersist = () => {
      if (persistTimer) return
      persistTimer = setTimeout(() => {
        persistTimer = null
        void persist()
        notify()
      }, 2000)
    }

    const providerFor = async (sessionID: string): Promise<string | undefined> => {
      const known = providerOf.get(sessionID)
      if (known) return known
      try {
        const s: any = await ctx.session.get({ sessionID })
        const prov = s?.model?.providerID
        if (prov) providerOf.set(sessionID, prov)
        if (s?.model?.id) modelOf.set(sessionID, s.model.id)
        return prov
      } catch {
        return undefined
      }
    }

    const modelFor = async (sessionID: string): Promise<string | undefined> => {
      const known = modelOf.get(sessionID)
      if (known) return known
      try {
        const s: any = await ctx.session.get({ sessionID })
        const id = s?.model?.id
        if (id) modelOf.set(sessionID, id)
        return id
      } catch {
        return undefined
      }
    }

    const readGoKey = (): string | undefined => {
      try {
        const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
        const path = process.env.OPENCODE_DB ?? join(base, "opencode", "opencode.db")
        const db = new Database(path, { readonly: true })
        try {
          const row: any = db
            .query(
              "select value from credential where integration_id = 'opencode-go' and active = 1 order by time_updated desc limit 1",
            )
            .get()
          if (!row?.value) return undefined
          const value = JSON.parse(row.value)
          if (value?.type === "key" && typeof value.key === "string") return value.key
          if (value?.type === "api" && typeof value.api === "string") return value.api
        } finally {
          db.close()
        }
      } catch {
        return undefined
      }
      return undefined
    }

    const normalizeUsage = (window: any): AccountWin | undefined => {
      if (!window || typeof window.resetsAt !== "string") return undefined
      const percent = typeof window.percent === "number" ? Math.min(100, Math.max(0, window.percent)) : 0
      return { percent, resetAt: window.resetsAt }
    }

    // Real Go meters from the API key: usage percent and exact reset times.
    async function refreshAccount() {
      if (refreshingAccount) return
      refreshingAccount = true
      try {
        const key = readGoKey()
        if (!key) return
        const res = await fetch("https://opencode.ai/zen/go/v1/usage", {
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
            "User-Agent": "opencode-quota-split/0.1",
          },
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) return
        const json: any = await res.json()
        const usage = json?.usage
        const h5 = normalizeUsage(usage?.rolling)
        const d7 = normalizeUsage(usage?.weekly)
        const d30 = normalizeUsage(usage?.monthly)
        if (h5 && d7 && d30) {
          account = { h5, d7, d30 }
          accountAt = Date.now()
          void ctx.storage.set("account", account).catch(() => {})
          notify()
        }
      } catch {
        /* API unavailable: keep local rolling windows */
      } finally {
        refreshingAccount = false
      }
    }

    const load = async () => {
      if (loaded) return
      loaded = true
      try {
        const stored: any = await ctx.storage.get("entries")
        if (Array.isArray(stored)) entries = stored.filter((e: any) => typeof e?.t === "number" && typeof e?.d === "number")
      } catch {
        /* no state yet */
      }
      try {
        const stored: any = await ctx.storage.get("account")
        if (stored?.h5 && stored?.d7 && stored?.d30) account = stored
      } catch {
        /* no state yet */
      }
      await seed()
      void refreshAccount()
    }

    const ensure = (): Promise<void> => (booting ??= load())

    // Seed cumulative token counters so deltas start from the current value.
    async function seed() {
      let cursor: unknown = undefined
      for (let guard = 0; guard < 100; guard++) {
        let page: any
        try {
          page = await ctx.session.list({ limit: 100, ...(cursor ? { cursor } : {}) })
        } catch {
          break
        }
        const items = Array.isArray(page) ? page : (page?.data ?? [])
        for (const s of items) {
          if (!s?.id) continue
          const prov = s?.model?.providerID
          if (prov) providerOf.set(s.id, prov)
          if (s?.model?.id) modelOf.set(s.id, s.model.id)
          if (s.tokens && !lastTokens.has(s.id)) lastTokens.set(s.id, s.tokens)
        }
        cursor = page?.cursor?.next
        if (!cursor || items.length === 0) break
      }
      prune()
      schedulePersist()
    }

    const controller = new AbortController()

    const handle = async (ev: any) => {
      if (ev?.type === "session.usage.updated") {
        const sessionID = ev?.data?.sessionID
        const tokens: Tokens | undefined = ev?.data?.tokens
        if (!sessionID || !tokens) return
        const prov = await providerFor(sessionID)
        if (!prov) return
        if (prov !== provider) {
          lastTokens.set(sessionID, tokens)
          return
        }
        const model = await modelFor(sessionID)
        if (model && model !== "deepseek-v4.1-flash") {
          lastTokens.set(sessionID, tokens)
          return
        }
        const delta = tokenDelta(lastTokens.get(sessionID), tokens)
        lastTokens.set(sessionID, tokens)
        const at = ev.created ?? Date.now()
        const cost = tokenCost(delta, at)
        if (cost > 0) {
          entries.push({ t: at, d: round(cost), sid: sessionID })
          prune()
          schedulePersist()
        }
      } else if (ev?.type === "session.model.selected") {
        const sessionID = ev?.data?.sessionID
        if (!sessionID) return
        const prov = ev?.data?.model?.providerID
        const id = ev?.data?.model?.id
        if (prov) providerOf.set(sessionID, prov)
        if (id) modelOf.set(sessionID, id)
      } else if (ev?.type === "session.created") {
        const sessionID = ev?.data?.sessionID
        if (!sessionID) return
        const prov = ev?.data?.model?.providerID
        const id = ev?.data?.model?.id
        if (prov) providerOf.set(sessionID, prov)
        if (id) modelOf.set(sessionID, id)
      } else if (ev?.type === "session.deleted") {
        const sessionID = ev?.data?.sessionID
        if (sessionID) {
          providerOf.delete(sessionID)
          modelOf.delete(sessionID)
          lastTokens.delete(sessionID)
        }
      }
    }

    void (async () => {
      await ensure()
      let delay = 1000
      while (!stopped && !controller.signal.aborted) {
        try {
          for await (const ev of ctx.event.subscribe({
            signal: controller.signal,
            types: [
              "session.usage.updated",
              "session.model.selected",
              "session.created",
              "session.deleted",
            ],
          })) {
            delay = 1000
            try {
              await handle(ev)
            } catch (e) {
              console.error("[quota-split] event error", ev?.type, e)
            }
          }
        } catch (e: any) {
          if (stopped || controller.signal.aborted) break
          console.error("[quota-split] event stream error", e?.message ?? e)
        }
        if (stopped || controller.signal.aborted) break
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 30_000)
      }
    })()

    ticker = setInterval(() => {
      void (async () => {
        await hydrate()
        prune()
        await refreshAccount()
        notify()
      })()
    }, 60_000)

    // Block new prompts once any window is exhausted.
    const hookReg = await ctx.session.hook("prompt", async () => {
      await ensure()
      await hydrate()
      prune()
      if (account && Date.now() - accountAt < 10 * 60_000) {
        const overall = Math.max(account.h5.percent, account.d7.percent, account.d30.percent)
        if (overall >= 100) {
          throw new Error(
            `[quota-split] Общая квота OpenCode Go исчерпана (${overall.toFixed(0)}%). ` +
              `Подожди сброса окна или включи Extra Usage в Console.`,
          )
        }
      }
      for (const w of WINDOWS) {
        const spent = sum(w.id, w.ms)
        if (spent >= limits[w.id]) {
          throw new Error(
            `[quota-split] Лимит ${w.label} исчерпан: $${spent.toFixed(2)} из $${limits[w.id].toFixed(2)}. ` +
              `Подожди сброса окна или подними лимит в opencode.jsonc → plugins → quota-split → options.limits.`,
          )
        }
      }
    })

    const rpcReg = await ctx.rpc.register(QuotaSplitRpc, {      usage: async (input: any) => {
        await ensure()
        await hydrate()
        prune()
        return snapshot(input?.sessionID)
      },
      setLimits: async (input: any) => {
        for (const w of WINDOWS) {
          const v = input?.limits?.[w.id]
          if (typeof v === "number" && v > 0 && v <= 10_000) limits[w.id] = v
        }
        await ctx.storage.set("limits", limits)
        notify()
        return snapshot()
      },
    })
    notify = () => {
      void rpcReg.events.emit("updated", {})
    }

    console.log(`[quota-split] active for ${provider}; limits 5h=$${limits.h5} 7d=$${limits.d7} 30d=$${limits.d30}`)
    void ensure()
    return () => {
      stopped = true
      controller.abort()
      if (persistTimer) clearTimeout(persistTimer)
      if (ticker) clearInterval(ticker)
      void hookReg.dispose().catch(() => {})
      void rpcReg.dispose().catch(() => {})
      void persist()
    }
  },
})
