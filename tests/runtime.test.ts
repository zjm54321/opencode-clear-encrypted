import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { probeRuntime, resolveRuntime, runHelper, setupServer, type ServerContext } from "../src/index"
import { reasons } from "../src/rpc"

const marker = "clear-encrypted-runtime-ok\n"
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(import.meta.dir, ".tmp-runtime-"))
  roots.push(root)
  const executable = join(root, "trusted runtime with spaces")
  writeFileSync(executable, "synthetic executable used only with mocked spawn", { mode: 0o700 })
  const moduleURL = pathToFileURL(join(root, "index.ts")).href
  symlinkSync(executable, join(root, "bun"))
  return { root, executable, moduleURL }
}
function processMock(text = marker, code = 0) {
  const child = { stdout: new Blob([text]).stream(), exited: Promise.resolve(code), kill() {} }
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => child) as typeof Bun.spawn)
  return spawn
}
async function boundary(resolve: () => Promise<string>) {
  const calls: string[] = []
  let clear!: Parameters<ServerContext["rpc"]["register"]>[1]["clear"]
  const ctx: ServerContext = {
    app: { version: "any-compatible-build", channel: "latest" },
    location: { directory: "/synthetic", project: { id: "project" } },
    rpc: { register: async (_, handlers) => { clear = handlers.clear } },
    session: {
      get: async () => { calls.push("get"); return { id: "session", projectID: "project", location: { directory: "/synthetic" } } },
      interrupt: async () => { calls.push("interrupt") },
      wait: async () => { calls.push("wait") },
    },
  }
  await setupServer(ctx, {
    timeout: 10_000,
    target: async () => ({ bun: await resolve(), dbPath: "/synthetic/db", backupDir: "/synthetic/backups" }),
    helper: async () => { calls.push("helper"); return { ok: true, changedMessages: 0, changedEvents: 0, removedFields: 0 } },
  })
  const result = await clear({ sessionID: "session" }, {
    signal: new AbortController().signal, error: (_, message) => ({ message }),
  })
  return { result, calls }
}

describe("explicit or bundled Bun resolution", () => {
  test("trusted absolute symlink to non-Nix Bun with spaces probes memory and uses canonical helper argv", async () => {
    const f = fixture()
    // The test runner executable is fixture input only, never product runtime selection.
    copyFileSync(process.execPath, f.executable, constants.COPYFILE_FICLONE)
    chmodSync(f.executable, 0o700)
    const link = join(f.root, "explicit bun link")
    symlinkSync(f.executable, link)
    const spawn = spyOn(Bun, "spawn")
    try {
      const bun = await resolveRuntime({ OPENCODE_CLEAR_ENCRYPTED_BUN: link }, f.moduleURL)
      expect(bun).toBe(realpathSync(f.executable))
      expect(bun.startsWith("/nix/store/")).toBe(false)
      const args = spawn.mock.calls[0][0] as string[]
      expect(args[0]).toBe(bun)
      expect(args[1]).toBe("--eval")
      expect(args[2]).toContain('new Database(":memory:"')
      expect(args[2]).toContain("json_tree")
      expect(args[2]).toContain("json_remove")
      expect(args[2]).toContain("safeIntegers: true")
      expect(args[2]).not.toContain(f.root)
      expect(spawn.mock.calls[0][1]).toEqual({ stdin: "ignore", stdout: "pipe", stderr: "ignore" })
      const success = { ok: true, changedMessages: 0, changedEvents: 0, removedFields: 0 }
      const child = {
        stdin: { write() {}, end() {} }, stdout: new Blob([JSON.stringify(success)]).stream(),
        exited: Promise.resolve(0), kill() {},
      }
      spawn.mockImplementation((() => child) as typeof Bun.spawn)
      await expect(runHelper({ operation: "clear", dbPath: "/synthetic/db", backupDir: "/synthetic/backups", directory: "/synthetic", sessionID: "session" }, bun, new AbortController().signal)).resolves.toEqual(success)
      expect(spawn.mock.calls[1][0]).toEqual([bun, join(import.meta.dir, "..", "src", "helper.ts")])
    } finally { spawn.mockRestore() }
  })

  test("absent override resolves only the package sibling bun", async () => {
    const f = fixture()
    const spawn = processMock()
    try {
      expect(await resolveRuntime({}, f.moduleURL)).toBe(realpathSync(f.executable))
      expect(spawn.mock.calls[0][0][0]).toBe(realpathSync(f.executable))
    } finally { spawn.mockRestore() }
  })

  test("hostile PATH is never searched when bundled runtime is missing", async () => {
    const f = fixture()
    const hostile = join(f.root, "hostile")
    mkdirSync(hostile)
    const invoked = join(f.root, "invoked")
    writeFileSync(join(hostile, "bun"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(invoked)}, "bad")`, { mode: 0o700 })
    const spawn = processMock()
    try {
      const result = await boundary(() => resolveRuntime({ PATH: hostile }, pathToFileURL(join(f.root, "missing", "index.ts")).href))
      expect(result).toEqual({ result: { message: reasons.runtime }, calls: [] })
      expect(spawn).not.toHaveBeenCalled()
      expect(existsSync(invoked)).toBe(false)
    } finally { spawn.mockRestore() }
  })

  for (const kind of ["empty", "relative", "undefined", "dangling", "directory", "nonexecutable"] as const)
    test(`invalid explicit ${kind} refuses before interruption without bundled fallback`, async () => {
      const f = fixture()
      let value: string | undefined = ""
      if (kind === "relative") value = "./bun"
      if (kind === "undefined") value = undefined
      if (kind === "dangling") { value = join(f.root, "dangling"); symlinkSync(join(f.root, "absent"), value) }
      if (kind === "directory") value = f.root
      if (kind === "nonexecutable") { value = join(f.root, "not-executable"); writeFileSync(value, "private", { mode: 0o600 }) }
      const spawn = processMock()
      try {
        expect(await boundary(() => resolveRuntime({ OPENCODE_CLEAR_ENCRYPTED_BUN: value }, f.moduleURL)))
          .toEqual({ result: { message: reasons.runtime }, calls: [] })
        expect(spawn).not.toHaveBeenCalled()
      } finally { spawn.mockRestore() }
    })

  for (const [name, text, code] of [
    ["exit zero without marker", "", 0], ["wrong executable", "private wrong runtime output", 0],
    ["failed probe", marker, 1], ["excess stdout", marker + "x".repeat(100_000), 0],
  ] as const) test(`${name} refuses before interruption/helper`, async () => {
    const f = fixture()
    const spawn = processMock(text, code)
    try {
      expect(await boundary(() => resolveRuntime({ OPENCODE_CLEAR_ENCRYPTED_BUN: f.executable }, f.moduleURL)))
        .toEqual({ result: { message: reasons.runtime }, calls: [] })
      expect(spawn).toHaveBeenCalledTimes(1)
    } finally { spawn.mockRestore() }
  })

  test("spawn failure is sanitized before interruption/helper", async () => {
    const f = fixture()
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("private loader details") })
    try {
      expect(await boundary(() => resolveRuntime({ OPENCODE_CLEAR_ENCRYPTED_BUN: f.executable }, f.moduleURL)))
        .toEqual({ result: { message: reasons.runtime }, calls: [] })
    } finally { spawn.mockRestore() }
  })

  test("timeout kills only probe, cancels stdout and awaits reaping before refusal", async () => {
    let exit!: (code: number) => void
    let killed!: () => void
    const exited = new Promise<number>((resolve) => { exit = resolve })
    const reached = new Promise<void>((resolve) => { killed = resolve })
    const signals: string[] = []
    let cancelled = false
    let finished = false
    const child = {
      stdout: new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }), exited,
      kill(signal: string) { signals.push(signal); killed() },
    }
    const spawn = spyOn(Bun, "spawn").mockImplementation((() => child) as typeof Bun.spawn)
    try {
      const task = boundary(async () => { await probeRuntime("/synthetic/trusted-bun", 5); return "/synthetic/trusted-bun" })
        .then((result) => { finished = true; return result })
      await reached
      await Promise.resolve()
      expect(signals).toEqual(["SIGKILL"])
      expect(cancelled).toBe(true)
      expect(finished).toBe(false)
      exit(137)
      expect(await task).toEqual({ result: { message: reasons.runtime }, calls: [] })
      expect(finished).toBe(true)
    } finally { exit(137); spawn.mockRestore() }
  })
})
