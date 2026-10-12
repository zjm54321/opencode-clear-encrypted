// SPDX-License-Identifier: GPL-3.0-or-later
import { constants } from "node:fs"
import { access, readdir, realpath, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { definition, id, reasons, safeReason, type ClearResult } from "./rpc"

type Location = { directory: string; workspaceID?: string }
type Call = { signal: AbortSignal; error(type: "failed", message: string, data: null): unknown }
export interface ServerContext {
  app: { version: string; channel: string }
  location: Location & { project: { id: string } }
  session: {
    get(input: { sessionID: string }, options?: { signal: AbortSignal }): Promise<{ id: string; projectID: string; location: Location }>
    interrupt(input: { sessionID: string; resume: false }, options?: { signal: AbortSignal }): Promise<unknown>
    wait(input: { sessionID: string }, options?: { signal: AbortSignal }): Promise<unknown>
  }
  rpc: { register(schema: typeof definition, handlers: { clear(input: unknown, call: Call): Promise<unknown> }): Promise<unknown> }
}
type Target = { dbPath: string; bun: string }
type HelperInput = { operation: "clear"; sessionID: string; directory: string; dbPath: string }
export interface Dependencies {
  target(channel: string): Promise<Target>
  helper(input: HelperInput, bun: string, signal: AbortSignal): Promise<ClearResult>
  timeout: number
}

export function databasePath(channel: string, env: NodeJS.ProcessEnv, home: string): string {
  const root = env.XDG_DATA_HOME || path.join(home, ".local", "share")
  if (!path.isAbsolute(root) || !channel) throw new Error(reasons.database)
  const filename = env.OPENCODE_DB ?? (["latest", "dev", "beta", "next", "prod"].includes(channel)
    || ["1", "true"].includes(env.OPENCODE_DISABLE_CHANNEL_DB ?? "")
    ? "opencode.db" : `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  if (!filename || filename === ":memory:" || /^(file:|https?:|libsql:)/i.test(filename)) throw new Error(reasons.database)
  return path.resolve(root, "opencode", filename)
}

const runtimeMarker = "clear-encrypted-runtime-ok\n"
// Static, in-memory only: no session, database path or user input reaches this probe.
const runtimeProbe = `
import { Database } from "bun:sqlite";
const db = new Database(":memory:", { strict: true, safeIntegers: true });
try {
  db.exec("BEGIN IMMEDIATE; CREATE TABLE probe (n INTEGER, data TEXT)");
  const insert = db.query("INSERT INTO probe VALUES (?, ?)").run(9007199254740993n, '{"keep":1,"drop":2}');
  const row = db.query("SELECT n, json_remove(data, '$.drop') AS data FROM probe").get();
  const tree = db.query("SELECT fullkey FROM json_tree(?) WHERE key IS NOT NULL GROUP BY parent, key HAVING count(*) > 1").all('{"x":1,"x":2}');
  if (Number(insert.changes) !== 1 || row.n !== 9007199254740993n || row.data !== '{"keep":1}' || tree.length !== 1) throw new Error();
  db.exec("ROLLBACK");
} finally { db.close(); }
process.stdout.write(${JSON.stringify(runtimeMarker)});
`

export async function probeRuntime(bun: string, timeout = 3_000): Promise<void> {
  try {
    const child = Bun.spawn([bun, "--eval", runtimeProbe], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
    const reader = child.stdout.getReader()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const output = async () => {
        let text = ""
        while (true) {
          const { done, value } = await reader.read()
          if (done) return text
          // Bound retained output; reject immediately instead of buffering arbitrary stdout.
          if (text.length + value.byteLength > runtimeMarker.length) throw new Error()
          text += new TextDecoder().decode(value)
          if (!runtimeMarker.startsWith(text)) throw new Error()
        }
      }
      const [code, text] = await Promise.race([
        Promise.all([child.exited, output()]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), timeout) }),
      ])
      if (code !== 0 || text !== runtimeMarker) throw new Error()
    } catch {
      try { child.kill("SIGKILL") } catch {}
      await reader.cancel().catch(() => {})
      await child.exited
      throw new Error(reasons.runtime)
    } finally {
      clearTimeout(timer)
      reader.releaseLock()
    }
  } catch { throw new Error(reasons.runtime) }
}

export async function resolveRuntime(env: NodeJS.ProcessEnv = process.env, moduleURL: string = import.meta.url): Promise<string> {
  try {
    // An explicit path authorizes this executable; it does not authenticate provenance.
    // An invalid override must NEVER fall back to the bundled link or PATH.
    const candidate = Object.hasOwn(env, "OPENCODE_CLEAR_ENCRYPTED_BUN")
      ? env.OPENCODE_CLEAR_ENCRYPTED_BUN : fileURLToPath(new URL("./bun", moduleURL))
    if (!candidate || !path.isAbsolute(candidate)) throw new Error()
    const bun = await realpath(candidate)
    if (!(await stat(bun)).isFile()) throw new Error()
    await access(bun, constants.X_OK)
    await probeRuntime(bun)
    return bun
  } catch { throw new Error(reasons.runtime) }
}

// Runs ONLY in the server plugin. The context doesn't expose Database.path; confirm
// the CLI-derived candidate is actually open in this process, never trust env alone.
export async function resolveTarget(channel: string): Promise<Target> {
  try {
    if (process.platform !== "linux") throw new Error(reasons.database)
    const dbPath = await realpath(databasePath(channel, process.env, os.homedir()))
    const identity = await stat(dbPath)
    if (!identity.isFile()) throw new Error(reasons.database)
    const open = await Promise.all((await readdir("/proc/self/fd")).map(async (fd) => {
      try {
        const info = await stat(`/proc/self/fd/${fd}`)
        return info.dev === identity.dev && info.ino === identity.ino
      } catch { return false }
    }))
    if (!open.some(Boolean)) throw new Error(reasons.database)
    const bun = await resolveRuntime()
    return { dbPath, bun }
  } catch (error) {
    throw new Error(safeReason(error) === reasons.runtime ? reasons.runtime : reasons.database)
  }
}

export async function runHelper(input: HelperInput, bun: string, signal: AbortSignal): Promise<ClearResult> {
  signal.throwIfAborted()
  const child = Bun.spawn([bun, fileURLToPath(new URL("./helper.ts", import.meta.url))], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
  })
  // Kill only OUR helper, never a session, service or process group.
  const abort = () => { try { child.kill("SIGKILL") } catch {} }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  try {
    child.stdin.write(JSON.stringify(input))
    child.stdin.end()
    const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()])
    const result = JSON.parse(text)
    // A confirmed commit wins over cancellation racing with process exit.
    if (code === 0 && result?.ok === true
      && [result.changedMessages, result.changedEvents, result.removedFields].every((x) => Number.isSafeInteger(x) && x >= 0)) return result
    throw new Error(reasons.helper)
  } catch {
    abort()
    await child.exited
    throw new Error(signal.aborted ? reasons.cancelled : reasons.helper)
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error(reasons.cancelled))
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

export async function setupServer(ctx: ServerContext, deps: Dependencies = { target: resolveTarget, helper: runHelper, timeout: 60_000 }) {
  if (typeof ctx?.rpc?.register !== "function") throw new Error(reasons.compatibility)
  const pending = new Set<string>()
  await ctx.rpc.register(definition, {
    async clear(input, call) {
      if (!input || typeof input !== "object" || Object.keys(input).length !== 1 || !("sessionID" in input)
        || typeof input.sessionID !== "string" || !input.sessionID.trim()) return call.error("failed", reasons.location, null)
      const sessionID = input.sessionID
      // Check ALL stop/settlement capabilities before any session can be interrupted.
      if (typeof ctx.session?.get !== "function" || typeof ctx.session?.interrupt !== "function"
        || typeof ctx.session?.wait !== "function") return call.error("failed", reasons.compatibility, null)
      if (typeof ctx.app?.channel !== "string" || !ctx.app.channel.trim()) return call.error("failed", reasons.database, null)
      const location = ctx.location
      if (typeof location?.directory !== "string" || !path.isAbsolute(location.directory)
        || typeof location.project?.id !== "string" || !location.project.id.trim()
        || (location.workspaceID !== undefined && (typeof location.workspaceID !== "string" || !location.workspaceID.trim())))
        return call.error("failed", reasons.location, null)
      const { directory, workspaceID, project: { id: projectID } } = location
      if (pending.has(sessionID)) return call.error("failed", reasons.busy, null)
      pending.add(sessionID)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), deps.timeout)
      const signal = AbortSignal.any([call.signal, controller.signal])
      try {
        signal.throwIfAborted()
        const target = await bounded(deps.target(ctx.app.channel), signal)
        const session = await bounded(ctx.session.get({ sessionID }, { signal }), signal)
        if (session?.id !== sessionID || session.projectID !== projectID
          || session.location?.directory !== directory
          || session.location.workspaceID !== workspaceID) throw new Error(reasons.location)
        try {
          signal.throwIfAborted()
          await bounded(ctx.session.interrupt({ sessionID, resume: false }, { signal }), signal)
          signal.throwIfAborted()
          await bounded(ctx.session.wait({ sessionID }, { signal }), signal)
          signal.throwIfAborted()
        } catch { throw new Error(reasons.stopped) }
        // No await between final abort check and helper launch. The helper independently
        // rechecks durable idle/location/identity inside its write transaction.
        return await deps.helper({ operation: "clear", sessionID, directory,
          dbPath: target.dbPath }, target.bun, signal)
      } catch (error) {
        return call.error("failed", safeReason(error), null)
      } finally {
        clearTimeout(timer)
        pending.delete(sessionID)
      }
    },
  })
}

export default { id, setup: setupServer }
