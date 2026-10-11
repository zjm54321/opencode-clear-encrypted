import { describe, expect, test, spyOn } from "bun:test"
import { join } from "node:path"
import plugin, { type TuiContext } from "../src/tui"
import { databasePath, runHelper, setupServer, type Dependencies, type ServerContext } from "../src/index"
import { definition, reasons } from "../src/rpc"

const success = { ok: true as const, changedMessages: 2, changedEvents: 3, removedFields: 4, backupPath: "/tmp/opencode/synthetic-backup.json" }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function replace(ctx: object, keys: string[], value: unknown) {
  let parent = ctx
  for (const key of keys.slice(0, -1)) parent = Reflect.get(parent, key)
  Reflect.set(parent, keys.at(-1)!, value)
}

function tui(configure: (ctx: TuiContext) => void = () => {}) {
  let layer!: ReturnType<Parameters<TuiContext["keymap"]["layer"]>[0]>
  let command!: ReturnType<Parameters<TuiContext["keymap"]["layer"]>[0]>["commands"][number]
  let route: { type: string; sessionID?: string } = { type: "session", sessionID: "ses_current" }
  const location = { directory: "/tmp/opencode/current", workspaceID: "wrk_current" }
  const toasts: string[] = []
  const calls: unknown[] = []
  const factories: unknown[] = []
  const messages: unknown[] = []
  const reply = deferred<unknown>()
  const ctx: TuiContext = {
    app: { version: "2.0.26+9b4ec57" },
    keymap: { layer(factory) { layer = factory(); command = layer.commands[0] } },
    ui: { router: { current: () => route }, toast: { show: ({ message }) => { toasts.push(message) } } },
    data: { session: { get: () => ({ location }), message: {
      invalidate: (id) => { messages.push(["invalidate", id]) },
      sync: async (id) => { messages.push(["sync", id]) },
    } } },
    client: { rpc(schema) { factories.push(schema); expect(schema).toBe(definition); return { clear: async (input, options) => {
      calls.push({ input, options }); return reply.promise
    } } } },
  }
  configure(ctx)
  plugin.setup(ctx)
  return { ctx, layer, command, location, toasts, calls, factories, messages, reply, route: (next: typeof route) => { route = next } }
}

describe("local slash wiring", () => {
  test("always registered; typed empty input captures session and copied location before await", async () => {
    const ui = tui()
    expect(ui.layer.mode).toBe("global")
    expect(ui.command.id).toBe("clear-encrypted")
    expect(ui.command.palette).toBe(true)
    expect(ui.command.slash).toEqual({ name: "clear-encrypted", arguments: true })
    expect("enabled" in ui.command).toBe(false)
    const task = ui.command.run("")
    ui.route({ type: "session", sessionID: "ses_independent" })
    ui.location.directory = "/tmp/opencode/changed"
    ui.reply.resolve(success)
    await task
    expect(ui.calls).toEqual([{ input: { sessionID: "ses_current" }, options: { location: { directory: "/tmp/opencode/current", workspaceID: "wrk_current" } } }])
    expect(ui.messages).toEqual([["invalidate", "ses_current"], ["sync", "ses_current"]])
    expect(ui.toasts[0]).toBe("正在停止当前会话并备份加密上下文…")
    expect(ui.toasts[1]).toContain("已清理加密推理上下文，聊天记录已保留。")
    expect(ui.toasts[1]).toContain(success.backupPath)
    // The mock intentionally exposes no prompt, generation, composer or model API.
  })

  test("outside session and nonempty arguments stay local", async () => {
    const ui = tui()
    ui.route({ type: "home" })
    await ui.command.run()
    expect(ui.toasts.pop()).toBe("当前页面没有会话")
    ui.route({ type: "session", sessionID: "ses_current" })
    await ui.command.run(" other-session ")
    expect(ui.toasts.pop()).toBe("此命令不接受参数")
    expect(ui.calls).toEqual([])
  })

  test("missing location fails before RPC", async () => {
    const ui = tui()
    ui.ctx.data.session.get = () => undefined
    await ui.command.run()
    expect(ui.toasts.pop()).toContain(reasons.location)
    expect(ui.calls).toEqual([])
  })

  for (const keys of [
    ["ui"], ["ui", "router"], ["ui", "router", "current"],
    ["ui", "toast"], ["ui", "toast", "show"],
    ["data"], ["data", "session"], ["data", "session", "get"],
    ["data", "session", "message"], ["data", "session", "message", "invalidate"], ["data", "session", "message", "sync"],
    ["client"], ["client", "rpc"],
  ]) for (const value of [undefined, "not callable"]) test(`missing/noncallable ${keys.join(".")} (${String(value)}): registered, local refusal before RPC`, async () => {
    const ui = tui((ctx) => replace(ctx, keys, value))
    expect(ui.layer.mode).toBe("global")
    expect(ui.command.palette).toBe(true)
    expect(ui.command.slash).toEqual({ name: "clear-encrypted", arguments: true })
    expect("enabled" in ui.command).toBe(false)
    if (typeof ui.ctx.ui?.toast?.show !== "function") await expect(ui.command.run()).rejects.toThrow(reasons.compatibility)
    else {
      await ui.command.run()
      expect(ui.toasts.at(-1)).toBe(`清理未完成：${reasons.compatibility}`)
    }
    expect(ui.factories).toEqual([])
    expect(ui.calls).toEqual([])
    expect(ui.messages).toEqual([])
  })

  for (const keys of [["keymap"], ["keymap", "layer"]]) for (const value of [undefined, "not callable"])
    test(`missing/noncallable ${keys.join(".")} (${String(value)}): explicit bootstrap failure`, () => {
      expect(() => tui((ctx) => replace(ctx, keys, value))).toThrow(reasons.compatibility)
    })

  for (const handle of [undefined, null, {}, { clear: "not callable" }]) test(`invalid RPC handle ${JSON.stringify(handle)} refuses without invocation`, async () => {
    const ui = tui((ctx) => { ctx.client.rpc = (() => handle) as TuiContext["client"]["rpc"] })
    await ui.command.run()
    expect(ui.toasts.at(-1)).toBe(`清理未完成：${reasons.compatibility}`)
    expect(ui.calls).toEqual([])
    expect(ui.messages).toEqual([])
  })

  test("busy callback still consumes command and no-op wording is exact", async () => {
    const ui = tui()
    const task = ui.command.run()
    await ui.command.run()
    expect(ui.calls).toHaveLength(1)
    expect(ui.toasts[1]).toContain(reasons.busy)
    ui.reply.resolve({ ok: true, changedMessages: 0, changedEvents: 0, removedFields: 0 })
    await task
    expect(ui.toasts.at(-1)).toBe("当前会话没有可清理的加密推理字段")
  })

  for (const failure of ["invalidate", "sync-throw", "sync-reject"] as const) test(`${failure} after commit reports commit, retains backup path`, async () => {
    const ui = tui()
    const notified = deferred<void>()
    const show = ui.ctx.ui.toast.show
    ui.ctx.ui.toast.show = (input) => {
      show(input)
      if (input.message.startsWith(reasons.refresh)) notified.resolve()
    }
    if (failure === "invalidate") ui.ctx.data.session.message.invalidate = () => { throw new Error("private contents") }
    else if (failure === "sync-throw") ui.ctx.data.session.message.sync = () => { throw new Error("private contents") }
    else ui.ctx.data.session.message.sync = async () => { throw new Error("private contents") }
    ui.reply.resolve(success)
    await ui.command.run()
    // Wait for the detached refresh's notification microtask, without timers/polling.
    await notified.promise
    expect(ui.toasts[1]).toContain("已清理加密推理上下文，聊天记录已保留。")
    expect(ui.toasts.at(-1)).toContain(reasons.refresh)
    expect(ui.toasts.at(-1)).toContain(success.backupPath)
    expect(ui.toasts.at(-1)).not.toContain("清理未完成：")
    expect(ui.toasts.at(-1)).not.toContain("private contents")
  })

  test("never-settling refresh does not hide success or retain local pending", async () => {
    const ui = tui()
    ui.ctx.data.session.message.sync = () => new Promise(() => {})
    ui.reply.resolve(success)
    await ui.command.run()
    expect(ui.toasts[1]).toContain("已清理加密推理上下文，聊天记录已保留。")
    expect(ui.toasts[1]).toContain(success.backupPath)
    expect(ui.messages).toEqual([["invalidate", "ses_current"]])
    await ui.command.run()
    expect(ui.calls).toHaveLength(2)
    expect(ui.toasts.some((message) => message.includes(reasons.busy))).toBe(false)
  })

  test("unknown RPC errors cannot leak payloads", async () => {
    const ui = tui()
    const task = ui.command.run()
    ui.reply.reject({ message: "ciphertext SECRET" })
    await task
    expect(ui.toasts.at(-1)).toBe(`清理未完成：${reasons.unknown}`)
  })
})

async function server(configure: (ctx: ServerContext) => void = () => {}) {
  let handler!: Parameters<ServerContext["rpc"]["register"]>[1]["clear"]
  const order: string[] = []
  const targets: unknown[] = []
  const ctx: ServerContext = {
    app: { version: "2.0.26+9b4ec57", channel: "latest" },
    location: { directory: "/tmp/opencode/current", project: { id: "prj_current" } },
    rpc: { register: async (schema, handlers) => { expect(schema).toBe(definition); handler = handlers.clear } },
    session: {
      get: async (input) => { order.push("get"); targets.push(input); return { id: input.sessionID, projectID: "prj_current", location: { directory: ctx.location.directory } } },
      interrupt: async (input) => { order.push("interrupt"); targets.push(input) },
      wait: async (input) => { order.push("wait"); targets.push(input) },
    },
  }
  const deps: Dependencies = {
    timeout: 1_000,
    target: async () => { order.push("target"); return { dbPath: "/tmp/opencode/synthetic.db", backupDir: "/tmp/opencode/backups", bun: "/synthetic/bun" } },
    helper: async (input) => { order.push("helper"); targets.push(input); return success },
  }
  configure(ctx)
  await setupServer(ctx, deps)
  const abort = new AbortController()
  const call = (input: unknown = { sessionID: "ses_current" }) => handler(input, {
    signal: abort.signal, error: (type, message, data) => ({ type, message, data }),
  })
  return { ctx, deps, order, targets, call, abort }
}

describe("server RPC boundary", () => {
  test("interrupt then wait settles before helper; targets only captured session", async () => {
    const s = await server()
    const waiting = deferred<void>()
    const reached = deferred<void>()
    s.ctx.session.wait = async (input) => { s.order.push("wait"); s.targets.push(input); reached.resolve(); return waiting.promise }
    const task = s.call()
    await reached.promise
    expect(s.order).toEqual(["target", "get", "interrupt", "wait"])
    waiting.resolve()
    expect(await task).toEqual(success)
    expect(s.order).toEqual(["target", "get", "interrupt", "wait", "helper"])
    expect(s.targets).toEqual([
      { sessionID: "ses_current" }, { sessionID: "ses_current", resume: false }, { sessionID: "ses_current" },
      { operation: "clear", sessionID: "ses_current", directory: "/tmp/opencode/current", dbPath: "/tmp/opencode/synthetic.db", backupDir: "/tmp/opencode/backups" },
    ])
  })

  for (const failure of ["interrupt", "wait"] as const) test(`${failure} failure never launches helper`, async () => {
    const s = await server()
    s.ctx.session[failure] = async () => { throw new Error("private payload") }
    expect(await s.call()).toMatchObject({ message: reasons.stopped })
    expect(s.order).not.toContain("helper")
  })

  test("settlement timeout and caller abort never launch helper", async () => {
    const s = await server()
    s.deps.timeout = 5
    s.ctx.session.wait = () => new Promise(() => {})
    expect(await s.call()).toMatchObject({ message: reasons.stopped })
    expect(s.order).not.toContain("helper")
    const aborted = await server()
    aborted.abort.abort()
    await aborted.call()
    expect(aborted.order).toEqual([])
  })

  for (const [client, service] of [
    ["2.0.26", "2.0.26"],
    ["2.0.26+9b4ec57", "2.0.26+different-build"],
    ["99.42.7+future", "99.42.7+future"],
    ["2.0.26+client", "123.0.0+server"],
    ["custom-client", "custom-server"],
  ]) test(`compatible client ${client} and server ${service} succeed regardless of version`, async () => {
    const s = await server((ctx) => { ctx.app.version = service })
    const ui = tui((ctx) => { ctx.app.version = client })
    ui.ctx.client.rpc = () => ({ clear: async (input) => s.call(input) })
    await ui.command.run()
    expect(s.order).toEqual(["target", "get", "interrupt", "wait", "helper"])
    expect(ui.toasts[1]).toContain("已清理加密推理上下文，聊天记录已保留。")
  })

  for (const keys of [["rpc"], ["rpc", "register"]]) for (const value of [undefined, "not callable"])
    test(`missing/noncallable server ${keys.join(".")} (${String(value)}): explicit bootstrap failure`, async () => {
      await expect(server((ctx) => replace(ctx, keys, value))).rejects.toThrow(reasons.compatibility)
    })

  for (const keys of [["session"], ["session", "get"], ["session", "interrupt"], ["session", "wait"]])
    for (const value of [undefined, "not callable"]) test(`missing/noncallable server ${keys.join(".")} (${String(value)}): zero interrupt and helper calls`, async () => {
      const s = await server((ctx) => replace(ctx, keys, value))
      expect(await s.call()).toMatchObject({ message: reasons.compatibility })
      expect(s.order).toEqual([])
      expect(s.targets).toEqual([])
    })

  for (const keys of [["app"], ["app", "channel"]]) test(`missing server ${keys.join(".")} refuses before interrupt`, async () => {
    const s = await server((ctx) => replace(ctx, keys, undefined))
    expect(await s.call()).toMatchObject({ message: reasons.database })
    expect(s.order).toEqual([])
  })

  for (const keys of [["location"], ["location", "project"], ["location", "project", "id"], ["location", "directory"]])
    test(`missing server ${keys.join(".")} refuses before interrupt`, async () => {
      const s = await server((ctx) => replace(ctx, keys, undefined))
      expect(await s.call()).toMatchObject({ message: reasons.location })
      expect(s.order).toEqual([])
    })

  for (const session of [undefined, null, {}, { id: "ses_other" }, { id: "ses_current", projectID: "prj_current" }])
    test(`invalid returned session ${JSON.stringify(session)} refuses before interrupt`, async () => {
      const s = await server((ctx) => { ctx.session.get = (async () => session) as ServerContext["session"]["get"] })
      expect(await s.call()).toMatchObject({ message: reasons.location })
      expect(s.order).toEqual(["target"])
    })

  test("wrong location/project/workspace is rejected without interrupt", async () => {
    for (const mismatch of [
      { projectID: "prj_other", location: { directory: "/tmp/opencode/current" } },
      { projectID: "prj_current", location: { directory: "/tmp/opencode/elsewhere" } },
      { projectID: "prj_current", location: { directory: "/tmp/opencode/current", workspaceID: "wrk_other" } },
    ]) {
      const s = await server()
      s.ctx.session.get = async () => ({ id: "ses_current", ...mismatch })
      expect(await s.call()).toMatchObject({ message: reasons.location })
      expect(s.order).not.toContain("interrupt")
    }
  })

  test("caller cannot provide database path, and duplicate requests do not interrupt twice", async () => {
    const s = await server()
    expect(await s.call({ sessionID: "ses_current", dbPath: "/elsewhere" })).toMatchObject({ message: reasons.location })
    expect(s.order).toEqual([])
    const waiting = deferred<void>()
    s.ctx.session.wait = () => waiting.promise
    const first = s.call()
    expect(await s.call()).toMatchObject({ message: reasons.busy })
    waiting.resolve()
    await first
    expect(s.order.filter((x) => x === "interrupt")).toHaveLength(1)
  })

  test("database resolution failure is before interrupt", async () => {
    const s = await server()
    s.deps.target = async () => { throw new Error(reasons.database) }
    expect(await s.call()).toMatchObject({ message: reasons.database })
    expect(s.order).toEqual([])
  })
})

describe("database naming (pure, no database access)", () => {
  test("matches CLI defaults, channels and OPENCODE_DB", () => {
    expect(databasePath("latest", {}, "/home/synthetic")).toBe("/home/synthetic/.local/share/opencode/opencode.db")
    expect(databasePath("feature/test", { XDG_DATA_HOME: "/tmp/opencode/data" }, "/unused")).toBe("/tmp/opencode/data/opencode/opencode-feature-test.db")
    expect(databasePath("custom", { OPENCODE_DISABLE_CHANNEL_DB: "true", OPENCODE_DB: "other.db" }, "/home/synthetic")).toBe("/home/synthetic/.local/share/opencode/other.db")
    expect(databasePath("custom", { OPENCODE_DB: "/tmp/opencode/explicit.db" }, "/unused")).toBe("/tmp/opencode/explicit.db")
  })
  test("rejects memory, URI, empty and relative XDG roots", () => {
    for (const OPENCODE_DB of [":memory:", "file:memory?mode=memory", "https://remote/db", "libsql://remote", ""])
      expect(() => databasePath("latest", { OPENCODE_DB }, "/unused")).toThrow(reasons.database)
    expect(() => databasePath("latest", { XDG_DATA_HOME: "relative" }, "/unused")).toThrow(reasons.database)
  })
})

describe("separate helper subprocess (mocked; no SQLite opened)", () => {
  const input = { operation: "clear" as const, dbPath: "/tmp/opencode/synthetic.db", sessionID: "ses_current", directory: "/tmp/opencode/current", backupDir: "/tmp/opencode/backups" }
  function processMock(text: string, code = 0) {
    const writes: string[] = []
    const killed: unknown[] = []
    const exit = deferred<number>()
    const child = {
      stdin: { write: (value: string) => { writes.push(value) }, end() {} },
      stdout: new Blob([text]).stream(), exited: exit.promise,
      kill: (signal: unknown) => { killed.push(signal); exit.resolve(code) },
    }
    const spawn = spyOn(Bun, "spawn").mockImplementation((() => child) as typeof Bun.spawn)
    return { spawn, writes, killed, exit }
  }

  test("uses supplied Bun, one JSON stdin, no shell and no execPath", async () => {
    const p = processMock(JSON.stringify(success))
    try {
      const task = runHelper(input, "/synthetic/bun", new AbortController().signal)
      p.exit.resolve(0)
      expect(await task).toEqual(success)
      expect(p.spawn.mock.calls[0][0][0]).toBe("/synthetic/bun")
      expect(p.spawn.mock.calls[0][0][1]).toBe(join(import.meta.dir, "..", "src", "helper.ts"))
      expect(p.writes).toEqual([JSON.stringify(input)])
      expect(p.killed).toEqual([])
    } finally { p.spawn.mockRestore() }
  })

  test("reported commit success wins a late cancellation", async () => {
    const p = processMock(JSON.stringify(success))
    try {
      const abort = new AbortController()
      const task = runHelper(input, "/synthetic/bun", abort.signal)
      abort.abort()
      expect(await task).toEqual(success)
      expect(p.killed).toEqual(["SIGKILL"])
    } finally { p.spawn.mockRestore() }
  })

  test("complete success JSON with cancelled exit 137 remains uncertain", async () => {
    const p = processMock(JSON.stringify(success), 137)
    try {
      const abort = new AbortController()
      const task = runHelper(input, "/synthetic/bun", abort.signal)
      abort.abort()
      await expect(task).rejects.toThrow(reasons.cancelled)
      expect(reasons.cancelled).toContain("检查备份和数据库状态")
      expect(reasons.cancelled).not.toContain("未执行清理")
      expect(p.killed.length).toBeGreaterThan(0)
    } finally { p.spawn.mockRestore() }
  })

  test("cancellation kills only child, unknown outcome never claims untouched", async () => {
    const p = processMock("", 137)
    try {
      const abort = new AbortController()
      const task = runHelper(input, "/synthetic/bun", abort.signal)
      abort.abort()
      await expect(task).rejects.toThrow(reasons.cancelled)
      expect(p.killed.length).toBeGreaterThan(0)
    } finally { p.spawn.mockRestore() }
  })

  test("helper failure details are suppressed", async () => {
    const p = processMock('{"ok":false,"error":"secret ciphertext"}', 1)
    try {
      const task = runHelper(input, "/synthetic/bun", new AbortController().signal)
      p.exit.resolve(1)
      await expect(task).rejects.toThrow(reasons.helper)
    } finally { p.spawn.mockRestore() }
  })
})
