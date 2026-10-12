#!/usr/bin/env bun
// SPDX-License-Identifier: GPL-3.0-or-later
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"

export type Request = { operation: "clear" | "restore"; dbPath: string; sessionID: string; directory: string; backupDir?: string; backupPath?: string }
type Result = { ok: true; changedMessages: number; changedEvents: number; removedFields: number } | { ok: false; error: string }
type ObjectValue = Record<string, any>
type Row = { id: string; type: string; data: string; [key: string]: unknown }
type Change = { table: "session_message" | "event"; id: string; original: string; cleaned: string; removedFields: number }
class Refusal extends Error {}
function requireSafe(condition: unknown, message: string): asserts condition { if (!condition) throw new Refusal(message) }
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value)
const own = (value: ObjectValue, key: string) => Object.hasOwn(value, key)
const encode = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? { sqliteInteger: v.toString() } : v)
const digest = (value: unknown) => createHash("sha256").update(encode(value)).digest("hex")

// Pinned to the six persistence tables in core 2.0.24+de2cacd. A suffix
// ! means NOT NULL; * means primary key. Extra/missing columns fail closed.
const schema: Record<string, string> = {
  session_v2: "id:text* project_id:text! workspace_id:text parent_id:text fork_session_id:text fork_boundary:text slug:text! directory:text! path:text title:text version:text! share_url:text summary_additions:integer summary_deletions:integer summary_files:integer summary_diffs:text metadata:text cost:real! tokens_input:integer! tokens_output:integer! tokens_reasoning:integer! tokens_cache_read:integer! tokens_cache_write:integer! revert:text permission:text agent:text model:text time_created:integer! time_updated:integer! time_idle:integer time_viewed:integer idle_outcome:text time_compacting:integer time_archived:integer time_suspended:integer resume_attempts:integer!",
  session_message: "id:text* session_id:text! type:text! seq:integer! time_created:integer! time_updated:integer! data:text!",
  session_pending: "id:text* session_id:text! type:text! data:text! delivery:text admitted_seq:integer! time_created:integer!",
  session_inbox: "id:text* session_id:text! type:text! payload:text! delivery:text! enqueued_seq:integer! time_created:integer!",
  event: "id:text* aggregate_id:text! seq:integer! created:integer! type:text! data:text!",
  event_sequence: "aggregate_id:text* seq:integer! owner_id:text",
}
function verifySchema(db: Database) {
  for (const [table, spec] of Object.entries(schema)) {
    const columns = db.query(`PRAGMA table_xinfo("${table}")`).all() as ObjectValue[]
    const actual = columns.map(c => `${c.name}:${String(c.type).toLowerCase()}${c.notnull ? "!" : ""}${c.pk ? "*" : ""}`).sort().join(" ")
    // Migration history may change physical column order, not the schema.
    requireSafe(actual === spec.split(" ").sort().join(" ") && columns.every(c => !c.hidden), "Unsupported database schema")
    const entry = db.query("SELECT type, sql FROM sqlite_schema WHERE name = ?").get(table) as ObjectValue | null
    requireSafe(entry?.type === "table" && !/\bVIRTUAL\b/i.test(entry.sql), "Unsupported database schema")
  }
  // Triggers could change unrelated history or timestamps during narrow updates.
  requireSafe(!db.query("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' LIMIT 1").get(), "Database triggers are unsupported")
}
function snapshot(db: Database, id: string) {
  return {
    session: db.query("SELECT * FROM session_v2 WHERE id = ?").get(id) as ObjectValue | null,
    sequence: db.query("SELECT * FROM event_sequence WHERE aggregate_id = ?").get(id) as ObjectValue | null,
    messages: db.query("SELECT * FROM session_message WHERE session_id = ? ORDER BY seq, id").all(id) as Row[],
    events: db.query("SELECT * FROM event WHERE aggregate_id = ? ORDER BY seq, id").all(id) as Row[],
  }
}
function parse(raw: string): ObjectValue {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Refusal("Invalid stored JSON") }
  requireSafe(object(value), "Unsupported stored JSON shape")
  return value
}
function guard(db: Database, request: Request, state: ReturnType<typeof snapshot>, directory: string) {
  requireSafe(state.session, "Session does not exist")
  requireSafe(realpathSync(state.session.directory) === directory, "Session directory mismatch")
  requireSafe(state.session.time_suspended === null && state.session.time_compacting === null, "Session has active execution or compaction")
  requireSafe(state.session.fork_session_id === null && state.session.fork_boundary === null && !db.query("SELECT 1 FROM session_v2 WHERE fork_session_id = ? LIMIT 1").get(request.sessionID), "Fork relationships are unsupported")
  // bus.ts sets owner_id on imported replay/claim, not ordinary local emission.
  // No non-null owner is safe to rewrite independently of its replica.
  requireSafe(state.sequence && state.sequence.owner_id === null, "Missing or replicated/owned event aggregate")
  for (const table of ["session_pending", "session_inbox"]) {
    requireSafe(!db.query(`SELECT 1 FROM ${table} WHERE session_id = ? LIMIT 1`).get(request.sessionID), "Session has pending or inbox work")
  }
  for (const row of state.messages) {
    const data = parse(row.data)
    if (row.type === "assistant") {
      requireSafe(object(data.time) && typeof data.time.completed === "number", "Session has unfinished assistant work")
      requireSafe(Array.isArray(data.content), "Unsupported assistant content")
      for (const content of data.content) {
        requireSafe(object(content), "Unsupported assistant content")
        if (content.type === "tool") requireSafe(["completed", "error"].includes(content.state?.status), "Session has unfinished tool work")
      }
    }
    if (row.type === "compaction") requireSafe(["completed", "failed"].includes(data.status), "Session has unfinished compaction work")
  }
  for (const row of state.events) {
    requireSafe(parse(row.data).sessionID === request.sessionID, "Event session identity mismatch")
    requireSafe(BigInt(row.seq as bigint) <= BigInt(state.sequence.seq), "Inconsistent event watermark")
  }
}

type Target = { value: ObjectValue; path: string; scope: string; metadata?: { value: ObjectValue; path: string } }
function targets(db: Database, row: Row, table: Change["table"], data: ObjectValue): Target[] {
  const result: Target[] = []
  const structural = new Set<string>()
  const containers: { value: ObjectValue; path: string }[] = []
  function nativeScope(owner: unknown) {
    requireSafe(typeof owner === "string" && owner.length > 0, "Missing reasoning owner identity")
    return encode(["assistant", owner, "native-flat-state"])
  }
  function content(items: unknown, prefix: string, owner: unknown) {
    structural.add(prefix)
    requireSafe(Array.isArray(items), "Unsupported reasoning content shape")
    items.forEach((item, i) => {
      requireSafe(object(item), "Unsupported reasoning content shape")
      structural.add(`${prefix}[${i}].type`)
      if (item.type !== "reasoning") return
      containers.push({ value: item, path: `${prefix}[${i}]` })
      if (!own(item, "state")) return
      requireSafe(object(item.state), "Unsupported reasoning state")
      result.push({ value: item.state, path: `${prefix}[${i}].state`, scope: nativeScope(owner) })
    })
  }
  function context() {
    structural.add("$.providerContext")
    if (!own(data, "providerContext")) return
    const ctx = data.providerContext
    structural.add("$.providerContext.messages")
    structural.add("$.providerContext.version")
    requireSafe(object(ctx) && ctx.version === 1 && Array.isArray(ctx.messages), "Unsupported provider context")
    ctx.messages.forEach((message: unknown, i: number) => {
      requireSafe(object(message), "Unsupported provider message")
      structural.add(`$.providerContext.messages[${i}].content`)
      if (!Array.isArray(message.content)) return // canonical user content can be a string
      message.content.forEach((item: unknown, j: number) => {
        requireSafe(object(item), "Unsupported provider content")
        const itemPath = `$.providerContext.messages[${i}].content[${j}]`
        structural.add(`${itemPath}.type`)
        if (item.type !== "reasoning") return
        containers.push({ value: item, path: itemPath })
        if (!own(item, "providerMetadata")) return
        requireSafe(object(item.providerMetadata), "Unsupported provider metadata")
        const path = `$.providerContext.messages[${i}].content[${j}].providerMetadata`
        for (const [key, value] of Object.entries(item.providerMetadata)) {
          requireSafe(object(value), "Unsupported provider namespace")
          // Quoted SQLite JSON labels support punctuation; refuse quote/backslash
          // labels rather than risk addressing a different node.
          requireSafe(!/["\\\u0000-\u001f]/.test(key), "Unsupported provider namespace key")
          result.push({ value, path: `${path}.${JSON.stringify(key)}`, scope: encode(["compaction", table, row.id, i, key]), metadata: { value: item.providerMetadata, path } })
        }
      })
    })
  }
  if (table === "session_message") {
    if (row.type === "assistant") content(data.content, "$.content", row.id)
    if (row.type === "compaction") context()
  } else {
    if (["session.reasoning.started.1", "session.reasoning.ended.1"].includes(row.type)) {
      structural.add("$.assistantMessageID")
      structural.add("$.sessionID")
      structural.add("$.state")
      requireSafe(!own(data, "reasoningEncryptedContent"), "Unknown encrypted reasoning shape")
      if (own(data, "state")) {
        requireSafe(object(data.state), "Unsupported reasoning event state")
        containers.push({ value: data.state, path: "$.state" })
        result.push({ value: data.state, path: "$.state", scope: nativeScope(data.assistantMessageID) })
      }
    }
    if (row.type === "session.message.content.updated.1") {
      structural.add("$.messageID")
      structural.add("$.sessionID")
      content(data.content, "$.content", data.messageID)
    }
    if (row.type === "session.compaction.ended.1") {
      structural.add("$.sessionID")
      context()
    }
  }
  // Only recognized reasoning containers are scanned for unsupported shapes.
  // User examples, tool payloads, errors and unrelated metadata are not targets.
  const allowed = new Set(result.map(t => t.value))
  function inspect(value: unknown) {
    if (!object(value) && !Array.isArray(value)) return
    if (object(value) && own(value, "reasoningEncryptedContent")) requireSafe(allowed.has(value), "Unknown encrypted reasoning shape")
    for (const child of Object.values(value)) inspect(child)
  }
  for (const container of containers) inspect(container.value)
  // Only ambiguous structural selectors or reasoning containers can affect the
  // plan. Duplicate example keys in unrelated objects must remain untouched.
  if (structural.size || containers.length) {
    const duplicates = db.query("SELECT fullkey FROM json_tree(?) WHERE key IS NOT NULL GROUP BY parent, key HAVING count(*) > 1").all(row.data) as { fullkey: string }[]
    for (const { fullkey } of duplicates) {
      requireSafe(!structural.has(fullkey) && !containers.some(c => fullkey === c.path || fullkey.startsWith(c.path + ".") || fullkey.startsWith(c.path + "[")), "Duplicate reasoning JSON keys are unsupported")
    }
  }
  return result
}
function plan(db: Database, state: ReturnType<typeof snapshot>): Change[] {
  const rows = ([...state.messages.map(row => ({ row, table: "session_message" as const })), ...state.events.map(row => ({ row, table: "event" as const }))]).map(entry => {
    return { ...entry, targets: targets(db, entry.row, entry.table, parse(entry.row.data)) }
  })
  const correlated = new Set<string>()
  for (const { targets } of rows) for (const { value, scope } of targets) {
    if (!own(value, "reasoningEncryptedContent")) continue
    requireSafe(value.reasoningEncryptedContent === null || typeof value.reasoningEncryptedContent === "string", "Unsupported encrypted reasoning value")
    if (own(value, "itemId")) {
      requireSafe(typeof value.itemId === "string", "Unsupported reasoning item identity")
      correlated.add(encode([scope, value.itemId]))
    }
  }
  const changes: Change[] = []
  for (const { row, table, targets } of rows) {
    let cleaned = row.data
    let removedFields = 0
    const paths = new Set<string>()
    const removedNamespaces = new Map<string, { count: number; value: ObjectValue }>()
    for (const target of targets) {
      const encrypted = own(target.value, "reasoningEncryptedContent")
      const paired = own(target.value, "itemId") && (encrypted || correlated.has(encode([target.scope, target.value.itemId])))
      const keys = [ ...(encrypted ? ["reasoningEncryptedContent"] : []), ...(paired ? ["itemId"] : []) ]
      if (!keys.length) continue
      removedFields += keys.length
      if (Object.keys(target.value).length === keys.length) {
        paths.add(target.path)
        if (target.metadata) {
          const entry = removedNamespaces.get(target.metadata.path) ?? { count: 0, value: target.metadata.value }
          entry.count++
          removedNamespaces.set(target.metadata.path, entry)
        }
      } else for (const key of keys) paths.add(`${target.path}.${key}`)
    }
    for (const [path, entry] of removedNamespaces) if (entry.count === Object.keys(entry.value).length) paths.add(path)
    // SQLite preserves integer tokens; never serialize parsed history through JS.
    for (const path of paths) cleaned = (db.query("SELECT json_remove(?, ?) AS data").get(cleaned, path) as { data: string }).data
    if (paths.size) changes.push({ table, id: row.id, original: row.data, cleaned, removedFields })
  }
  return changes
}
function privateStat(path: string, directory: boolean) {
  const stat = lstatSync(path)
  requireSafe((directory ? stat.isDirectory() : stat.isFile()) && stat.uid === process.getuid!() && (stat.mode & 0o777) === (directory ? 0o700 : 0o600), "Backup must be private and owned by the current user")
}
function readBackup(path: string) {
  privateStat(path, false)
  privateStat(join(path, ".."), true)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    requireSafe(stat.isFile() && stat.uid === process.getuid!() && (stat.mode & 0o777) === 0o600, "Unsafe backup file")
    return parse(readFileSync(fd, "utf8"))
  } finally { closeSync(fd) }
}

export function runCleanup(input: unknown): Result {
  let db: Database | undefined
  let transaction = false
  try {
    requireSafe(object(input) && ["clear", "restore"].includes(input.operation), "Invalid operation")
    for (const key of ["dbPath", "sessionID", "directory"]) requireSafe(typeof input[key] === "string" && input[key].length > 0, "Missing request identity")
    if (input.operation === "restore") requireSafe(typeof input.backupPath === "string" && input.backupPath.length > 0, "Missing backup path")
    const request = input as Request
    const dbPath = realpathSync(request.dbPath)
    const directory = realpathSync(request.directory)
    const stat = statSync(dbPath, { bigint: true })
    requireSafe(stat.isFile() && statSync(directory).isDirectory(), "Invalid database or directory")
    const identity = { dbPath, directory, sessionID: request.sessionID, device: stat.dev.toString(), inode: stat.ino.toString() }
    // Restore filesystem reads stay outside the writer lock.
    const backup = request.operation === "restore" ? readBackup(request.backupPath!) : undefined
    db = new Database(dbPath, { create: false, strict: true, safeIntegers: true })
    db.exec("PRAGMA busy_timeout = 1000; PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL; BEGIN")
    transaction = true
    verifySchema(db)
    const state = snapshot(db, request.sessionID)
    guard(db, request, state, directory)
    let changes: Change[]
    if (request.operation === "clear") {
      changes = plan(db, state)
    } else {
      requireSafe(backup && backup.version === 1 && encode(backup.identity) === encode(identity), "Backup identity mismatch")
      requireSafe(backup.watermark === encode(state.sequence) && backup.postDigest === digest(state), "Restore conflict: session changed since cleanup")
      requireSafe(Array.isArray(backup.changes) && backup.changes.length > 0, "Invalid backup changes")
      changes = backup.changes
      const ids = new Set<string>()
      for (const c of changes) {
        requireSafe(object(c) && ["event", "session_message"].includes(c.table) && typeof c.id === "string" && typeof c.original === "string" && typeof c.cleaned === "string" && Number.isSafeInteger(c.removedFields) && c.removedFields > 0, "Invalid backup row")
        requireSafe(!ids.has(`${c.table}:${c.id}`), "Duplicate backup row")
        ids.add(`${c.table}:${c.id}`)
        const row = (c.table === "event" ? state.events : state.messages).find(row => row.id === c.id)
        requireSafe(row?.data === c.cleaned, "Restore conflict: post-image changed")
      }
      const original = { ...state, messages: state.messages.map(row => ({ ...row, data: changes.find(c => c.table === "session_message" && c.id === row.id)?.original ?? row.data })), events: state.events.map(row => ({ ...row, data: changes.find(c => c.table === "event" && c.id === row.id)?.original ?? row.data })) }
      requireSafe(encode(plan(db, original)) === encode(changes), "Backup is not a narrow reasoning cleanup")
    }
    db.exec("COMMIT")
    transaction = false
    if (changes.length) {
      // Work may have been admitted while planning. Never interrupt
      // again: acquire the short writer lock, repeat every guard, then compare.
      db.exec("BEGIN IMMEDIATE")
      transaction = true
      verifySchema(db)
      const current = snapshot(db, request.sessionID)
      guard(db, request, current, directory)
      requireSafe(digest(current) === digest(state), "Session changed during cleanup")
      for (const c of changes) {
        const restoring = request.operation === "restore"
        const updated = db.query(`UPDATE ${c.table} SET data = ? WHERE id = ? AND ${c.table === "event" ? "aggregate_id" : "session_id"} = ? AND data = ?`).run(restoring ? c.original : c.cleaned, c.id, request.sessionID, restoring ? c.cleaned : c.original)
        requireSafe(updated.changes === 1, "Concurrent row change; transaction rolled back")
      }
      db.exec("COMMIT")
      transaction = false
    }
    return { ok: true, changedMessages: changes.filter(c => c.table === "session_message").length, changedEvents: changes.filter(c => c.table === "event").length, removedFields: changes.reduce((n, c) => n + c.removedFields, 0) }
  } catch (error) {
    // SQLite/filesystem/JSON errors may contain history or paths: never echo them.
    return { ok: false, error: error instanceof Refusal ? error.message : "Cleanup failed: database or filesystem operation unavailable" }
  } finally {
    if (transaction) { try { db?.exec("ROLLBACK") } catch {} }
    db?.close()
  }
}

if (import.meta.main) {
  let result: Result
  try {
    requireSafe(process.argv.length === 2, "Command-line arguments are not accepted; use one JSON request on stdin")
    result = runCleanup(JSON.parse(await Bun.stdin.text()))
  } catch (error) { result = { ok: false, error: error instanceof Refusal ? error.message : "Invalid JSON request" } }
  process.stdout.write(JSON.stringify(result) + "\n")
  if (!result.ok) process.exitCode = 1
}
