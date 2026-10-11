import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as fs from "node:fs"
import { runCleanup } from "../src/helper"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(import.meta.dir, ".tmp-clear-helper-test-"))
  roots.push(root)
  const dbPath = join(root, "fixture.sqlite")
  const directory = join(root, "project")
  mkdirSync(directory)
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session_v2 (
      id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text,
      fork_session_id text, fork_boundary text, slug text NOT NULL, directory text NOT NULL,
      path text, title text, version text NOT NULL, share_url text, summary_additions integer,
      summary_deletions integer, summary_files integer, summary_diffs text, metadata text,
      cost real NOT NULL DEFAULT 0, tokens_input integer NOT NULL DEFAULT 0,
      tokens_output integer NOT NULL DEFAULT 0, tokens_reasoning integer NOT NULL DEFAULT 0,
      tokens_cache_read integer NOT NULL DEFAULT 0, tokens_cache_write integer NOT NULL DEFAULT 0,
      revert text, permission text, agent text, model text, time_created integer NOT NULL,
      time_updated integer NOT NULL, time_idle integer, time_viewed integer, idle_outcome text,
      time_compacting integer, time_archived integer, time_suspended integer,
      resume_attempts integer NOT NULL DEFAULT 0
    );
    CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL REFERENCES session_v2(id), type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);
    CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text);
    CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL REFERENCES event_sequence(aggregate_id), seq integer NOT NULL, created integer NOT NULL DEFAULT 0, type text NOT NULL, data text NOT NULL);
    CREATE UNIQUE INDEX event_aggregate_seq_idx ON event(aggregate_id, seq);
    CREATE TABLE session_pending (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, data text NOT NULL, delivery text, admitted_seq integer NOT NULL, time_created integer NOT NULL);
    CREATE TABLE session_inbox (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, payload text NOT NULL, delivery text NOT NULL, enqueued_seq integer NOT NULL, time_created integer NOT NULL);
  `)
  for (const id of ["target", "other"]) {
    db.query("INSERT INTO session_v2(id, project_id, slug, directory, version, time_created, time_updated) VALUES (?, 'project', ?, ?, '2.0.24', 1, 2)").run(id, id, directory)
    db.query("INSERT INTO event_sequence VALUES (?, 20, NULL)").run(id)
  }
  const message = (id: string, type: string, data: unknown, session = "target", seq = 1) => db.query("INSERT INTO session_message VALUES (?, ?, ?, ?, 1, 2, ?)").run(id, session, type, seq, typeof data === "string" ? data : JSON.stringify(data))
  const event = (id: string, type: string, data: unknown, session = "target", seq = 1) => {
    const identity = ["session.reasoning.started.1", "session.reasoning.ended.1"].includes(type) ? { assistantMessageID: "m", ordinal: 0, ...(type === "session.reasoning.ended.1" ? { text: "reasoning" } : {}) } : {}
    return db.query("INSERT INTO event VALUES (?, ?, ?, 3, ?, ?)").run(id, session, seq, type, JSON.stringify({ ...identity, ...(data as object) }))
  }
  const request = { operation: "clear" as const, dbPath, sessionID: "target", directory, backupDir: join(root, "backups") }
  const snapshot = () => JSON.stringify(["session_v2", "session_message", "event", "event_sequence", "session_pending", "session_inbox"].map(table => db.query(`SELECT * FROM ${table} ORDER BY 1`).all()))
  const data = (table: string, id: string) => JSON.parse((db.query(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string }).data)
  return { root, db, message, event, request, snapshot, data }
}
const reasoning = (state: unknown = { reasoningEncryptedContent: "secret", itemId: "reason-1" }) => ({ type: "reasoning", text: "readable reasoning", time: { created: 1, completed: 2 }, state })
const assistant = (content = [reasoning()]) => ({ time: { created: 1, completed: 2 }, content })
const context = () => ({ version: 1, provenance: { providerID: "openai", provider: "openai", modelID: "m", route: "r", protocol: "responses", endpoint: "digest" }, messages: [{ role: "assistant", content: [
  { type: "reasoning", text: "summary reasoning", providerMetadata: { openai: { reasoningEncryptedContent: null, itemId: "context-1" } } },
  { type: "reasoning", text: "fragment", providerMetadata: { openai: { itemId: "context-1" }, anthropic: { signature: "keep" } } },
  { type: "compaction", encrypted: "native-checkpoint", providerMetadata: { openai: { itemId: "native-id" } } },
] }] })

describe("bounded current-session cleanup", () => {
  test("correlation is limited to the owning message and provider namespace", () => {
    const f = fixture()
    try {
      f.message("m", "assistant", assistant([reasoning(), reasoning({ itemId: "reason-1", signature: "keep" })]))
      f.message("collision", "assistant", assistant([reasoning({ itemId: "reason-1" })]), "target", 2)
      f.event("same-owner", "session.reasoning.started.1", { sessionID: "target", assistantMessageID: "m", state: { itemId: "reason-1" } })
      f.event("other-owner", "session.reasoning.started.1", { sessionID: "target", assistantMessageID: "collision", state: { itemId: "reason-1" } }, "target", 2)
      f.event("updated-copy", "session.message.content.updated.1", { sessionID: "target", messageID: "m", content: [reasoning({ itemId: "reason-1" })] }, "target", 3)
      const ctx = context()
      ;(ctx.messages[0].content[0] as any).providerMetadata.other = { itemId: "context-1" }
      ctx.messages.push({ role: "assistant", content: [{ type: "reasoning", text: "other canonical message", providerMetadata: { openai: { itemId: "context-1" } } }] } as any)
      f.message("compact", "compaction", { status: "completed", providerContext: ctx }, "target", 3)
      const separate = context()
      delete (separate.messages[0].content[0] as any).providerMetadata.openai.reasoningEncryptedContent
      f.message("other-compact", "compaction", { status: "completed", providerContext: separate }, "target", 4)
      const before = f.snapshot()
      const result = runCleanup(f.request)
      expect(result.ok).toBe(true)
      if (!result.ok) throw Error(result.error)
      expect(f.data("session_message", "m").content[1].state).toEqual({ signature: "keep" })
      expect(f.data("session_message", "collision").content[0].state).toEqual({ itemId: "reason-1" })
      expect(f.data("event", "same-owner").state).toBeUndefined()
      expect(f.data("event", "other-owner").state).toEqual({ itemId: "reason-1" })
      expect(f.data("event", "updated-copy").content[0].state).toBeUndefined()
      const cleaned = f.data("session_message", "compact").providerContext.messages
      expect(cleaned[0].content[0].providerMetadata).toEqual({ other: { itemId: "context-1" } })
      expect(cleaned[0].content[1].providerMetadata).toEqual({ anthropic: { signature: "keep" } })
      expect(cleaned[1].content[0].providerMetadata.openai.itemId).toBe("context-1")
      expect(f.data("session_message", "other-compact").providerContext).toEqual(separate)
      expect(runCleanup({ ...f.request, operation: "restore", backupPath: result.backupPath }).ok).toBe(true)
      expect(f.snapshot()).toBe(before)
    } finally { f.db.close() }
  })

  test("unrelated structured encrypted examples and duplicate example keys are preserved", () => {
    const f = fixture()
    try {
      const example = '{"reasoningEncryptedContent":"example","duplicate":1,"duplicate":2}'
      const user = `{"content":[{"type":"text","text":"example"}],"metadata":${example}}`
      f.message("user", "user", user)
      const terminal = JSON.stringify(assistant()).slice(0, -1)
      f.message("m", "assistant", `${terminal},"error":{"data":${example}},"providerState":${example},"metadata":${example}}`, "target", 2)
      f.message("tool", "assistant", `{"time":{"completed":2},"content":[{"type":"tool","state":{"status":"completed","input":${example},"content":[{"type":"text","text":"tool"}]}}]}`, "target", 3)
      f.event("error", "session.error.1", { sessionID: "target", error: { data: { reasoningEncryptedContent: "not reasoning state" } } })
      const before = f.snapshot()
      const result = runCleanup(f.request)
      expect(result.ok).toBe(true)
      if (!result.ok) throw Error(result.error)
      expect(result.changedMessages).toBe(1)
      expect(result.changedEvents).toBe(0)
      expect((f.db.query("SELECT data FROM session_message WHERE id = 'user'").get() as any).data).toBe(user)
      const raw = (f.db.query("SELECT data FROM session_message WHERE id = 'm'").get() as any).data
      expect(raw).toContain(`"metadata":${example}`)
      expect(raw).toContain(`"error":{"data":${example}}`)
      expect(f.data("session_message", "m").content[0].state).toBeUndefined()
      expect(runCleanup({ ...f.request, operation: "restore", backupPath: result.backupPath }).ok).toBe(true)
      expect(f.snapshot()).toBe(before)
    } finally { f.db.close() }
  })

  test("terminal assistants allow optional historical reasoning completion timestamps", () => {
    const f = fixture()
    try {
      f.message("m", "assistant", assistant())
      f.db.exec("UPDATE session_message SET data = json_remove(data, '$.content[0].time.completed')")
      const result = runCleanup(f.request)
      expect(result.ok).toBe(true)
      expect(f.data("session_message", "m").content[0].time).toEqual({ created: 1 })
      expect(f.data("session_message", "m").content[0].state).toBeUndefined()
    } finally { f.db.close() }
  })

  test("backup releases database locks; intervening changes or admissions fail final recheck", () => {
    for (const mutation of ["other-only", "target", "pending", "inbox", "fork", "owner"]) {
      const f = fixture()
      let sync: ReturnType<typeof spyOn> | undefined
      try {
        f.message("m", "assistant", assistant())
        const original = (f.db.query("SELECT data FROM session_message WHERE id = 'm'").get() as any).data
        const fsync = fs.fsyncSync
        let wrote = false
        sync = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
          if (!wrote && fs.fstatSync(fd).isFile()) {
            // This is a separate connection from the helper, in rollback-journal
            // mode: both a lingering read lock and a writer lock prevent commit.
            f.db.exec("PRAGMA busy_timeout = 0; UPDATE session_v2 SET title = 'independent writer' WHERE id = 'other'")
            if (mutation === "target") f.db.exec("UPDATE session_v2 SET title = 'new target metadata' WHERE id = 'target'")
            if (mutation === "pending") f.db.exec("INSERT INTO session_pending VALUES ('new', 'target', 'user', '{}', NULL, 21, 4)")
            if (mutation === "inbox") f.db.exec("INSERT INTO session_inbox VALUES ('new', 'target', 'user', '{}', 'next', 21, 4)")
            if (mutation === "fork") f.db.exec("UPDATE session_v2 SET fork_session_id = 'target' WHERE id = 'other'")
            if (mutation === "owner") f.db.exec("UPDATE event_sequence SET owner_id = 'replica' WHERE aggregate_id = 'target'")
            wrote = true
          }
          fsync(fd)
        })
        const result = runCleanup(f.request)
        expect(wrote).toBe(true)
        expect(result.ok).toBe(mutation === "other-only")
        expect((f.db.query("SELECT title FROM session_v2 WHERE id = 'other'").get() as any).title).toBe("independent writer")
        if (mutation !== "other-only") expect((f.db.query("SELECT data FROM session_message WHERE id = 'm'").get() as any).data).toBe(original)
        expect(readdirSync(f.request.backupDir)).toHaveLength(1)
      } finally { sync?.mockRestore(); f.db.close() }
    }
  })

  test("cleans all native/event/context targets, keeps other content and restores exact raw rows", () => {
    const f = fixture()
    try {
      f.db.query("UPDATE session_v2 SET parent_id = 'parent' WHERE id = 'target'").run() // not a fork
      f.message("old", "assistant", '{"time":{"created":1,"completed":2},"huge":9007199254740993123,"content":[{"type":"reasoning","text":"readable reasoning","state":{"reasoningEncryptedContent":null,"itemId":"reason-1"}},{"type":"text","text":"answer"},{"type":"tool","name":"read","state":{"status":"completed","content":[{"type":"text","text":"tool output"}]},"providerState":{"itemId":"reason-1"}}]}')
      f.message("fragment", "assistant", assistant([reasoning({ itemId: "reason-1", signature: "keep" }), reasoning({ itemId: "unrelated" })]), "target", 2)
      f.message("compaction", "compaction", { status: "completed", summary: "summary", recent: "old", providerContext: context() }, "target", 3)
      f.message("other", "assistant", assistant(), "other")
      f.event("start", "session.reasoning.started.1", { sessionID: "target", assistantMessageID: "old", ordinal: 0, state: { itemId: "reason-1" } })
      f.event("end", "session.reasoning.ended.1", { sessionID: "target", assistantMessageID: "old", ordinal: 0, text: "readable reasoning", state: { reasoningEncryptedContent: "secret", itemId: "reason-1" } }, "target", 2)
      f.event("updated", "session.message.content.updated.1", { sessionID: "target", messageID: "old", content: [reasoning()] }, "target", 3)
      f.event("compact", "session.compaction.ended.1", { sessionID: "target", providerContext: context(), text: "summary" }, "target", 4)
      f.event("other-event", "session.reasoning.ended.1", { sessionID: "other", state: { reasoningEncryptedContent: "other-secret", itemId: "reason-1" } }, "other")
      const before = f.snapshot()
      const result = runCleanup(f.request)
      expect(result.ok).toBe(true)
      if (!result.ok) throw Error(result.error)
      expect(result.changedMessages).toBe(2)
      expect(result.changedEvents).toBe(4)
      expect(result.removedFields).toBe(13)
      expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600)
      expect(statSync(f.request.backupDir).mode & 0o777).toBe(0o700)
      const old = f.data("session_message", "old")
      expect(old.content[0].state).toBeUndefined()
      expect(old.content[0].text).toBe("readable reasoning")
      expect(old.content[1].text).toBe("answer")
      expect(old.content[2].providerState.itemId).toBe("reason-1")
      expect(f.data("session_message", "fragment").content.map((c: any) => c.state)).toEqual([{ itemId: "reason-1", signature: "keep" }, { itemId: "unrelated" }])
      const ctx = f.data("session_message", "compaction").providerContext.messages[0].content
      expect(ctx[0].providerMetadata).toBeUndefined()
      expect(ctx[1].providerMetadata).toEqual({ anthropic: { signature: "keep" } })
      expect(ctx[2].encrypted).toBe("native-checkpoint")
      expect(ctx[2].providerMetadata.openai.itemId).toBe("native-id")
      expect(f.data("event", "start").state).toBeUndefined()
      expect(f.data("event", "end").text).toBe("readable reasoning")
      expect(f.data("event", "updated").content[0].state).toBeUndefined()
      expect(f.data("event", "compact").providerContext.messages[0].content[0].providerMetadata).toBeUndefined()
      expect(f.data("session_message", "other").content[0].state.reasoningEncryptedContent).toBe("secret")
      expect(f.data("event", "other-event").state.reasoningEncryptedContent).toBe("other-secret")
      const raw = (f.db.query("SELECT data FROM session_message WHERE id = 'old'").get() as any).data
      expect(raw).toContain('"huge":9007199254740993123')
      const withoutData = (snapshot: string) => JSON.parse(snapshot).map((table: any[], i: number) => table.map(row => {
        if (i !== 1 && i !== 2) return row
        const { data, ...columns } = row
        return columns
      }))
      expect(withoutData(f.snapshot())).toEqual(withoutData(before))
      expect(runCleanup(f.request)).toEqual({ ok: true, changedMessages: 0, changedEvents: 0, removedFields: 0 })
      expect(readdirSync(f.request.backupDir)).toHaveLength(1)
      const restored = runCleanup({ ...f.request, operation: "restore", backupPath: result.backupPath })
      expect(restored.ok).toBe(true)
      expect(f.snapshot()).toBe(before)
    } finally { f.db.close() }
  })

  for (const kind of ["active", "compacting", "pending", "inbox", "unfinished", "tool", "missing-reasoning-owner", "compaction", "fork", "fork-child", "owned", "no-sequence", "schema", "trigger", "directory", "unknown", "duplicate", "event-identity", "future-event", "backup-failure"]) {
    test(`refuses ${kind} without mutating any rows`, () => {
      const f = fixture()
      try {
        f.message("m", "assistant", assistant())
        if (kind === "active") f.db.exec("UPDATE session_v2 SET time_suspended = 123 WHERE id = 'target'")
        if (kind === "compacting") f.db.exec("UPDATE session_v2 SET time_compacting = 123 WHERE id = 'target'")
        if (kind === "pending") f.db.exec("INSERT INTO session_pending VALUES ('p', 'target', 'user', '{}', NULL, 2, 3)")
        if (kind === "inbox") f.db.exec("INSERT INTO session_inbox VALUES ('p', 'target', 'user', '{}', 'next', 2, 3)")
        if (kind === "unfinished") f.db.exec("UPDATE session_message SET data = json_remove(data, '$.time.completed')")
        if (kind === "tool") f.message("busy", "assistant", assistant([{ type: "tool", state: { status: "running" } } as any]), "target", 2)
        if (kind === "missing-reasoning-owner") f.event("bad", "session.reasoning.ended.1", { sessionID: "target", assistantMessageID: undefined, state: { itemId: "reason-1" } })
        if (kind === "compaction") f.message("busy", "compaction", { status: "running" }, "target", 2)
        if (kind === "fork") f.db.exec("UPDATE session_v2 SET fork_session_id = 'other' WHERE id = 'target'")
        if (kind === "fork-child") f.db.exec("UPDATE session_v2 SET fork_session_id = 'target' WHERE id = 'other'")
        if (kind === "owned") f.db.exec("UPDATE event_sequence SET owner_id = 'replica' WHERE aggregate_id = 'target'")
        if (kind === "no-sequence") f.db.exec("DELETE FROM event_sequence WHERE aggregate_id = 'target'")
        if (kind === "schema") f.db.exec("ALTER TABLE session_message ADD COLUMN future text")
        if (kind === "trigger") f.db.exec("CREATE TRIGGER unsafe AFTER UPDATE ON session_message BEGIN UPDATE session_v2 SET title = 'changed'; END")
        if (kind === "directory") f.request.directory = f.root
        if (kind === "unknown") f.db.exec("UPDATE session_message SET data = json_set(data, '$.content[0].state.nested.reasoningEncryptedContent', 'hidden')")
        if (kind === "duplicate") f.db.query("UPDATE session_message SET data = ?").run('{"time":{"completed":2},"content":[],"content":[{"type":"reasoning","state":{"reasoningEncryptedContent":"hidden"}}]}')
        if (kind === "event-identity") f.event("bad", "session.reasoning.ended.1", { sessionID: "other", state: { reasoningEncryptedContent: "secret" } })
        if (kind === "future-event") f.event("bad", "session.reasoning.ended.1", { sessionID: "target", state: { reasoningEncryptedContent: "secret" } }, "target", 21)
        if (kind === "backup-failure") f.request.backupDir = f.request.dbPath
        const before = f.snapshot()
        expect(runCleanup(f.request).ok).toBe(false)
        expect(f.snapshot()).toBe(before)
      } finally { f.db.close() }
    })
  }

  for (const conflict of ["watermark", "postimage", "timestamp", "new-message", "identity", "busy", "owned", "fork", "tampered-backup"]) {
    test(`restore fails closed on ${conflict}`, () => {
      const f = fixture()
      try {
        f.message("m", "assistant", assistant())
        const result = runCleanup(f.request)
        expect(result.ok).toBe(true)
        if (!result.ok) throw Error(result.error)
        if (conflict === "watermark") f.db.exec("UPDATE event_sequence SET seq = 21 WHERE aggregate_id = 'target'")
        if (conflict === "postimage") f.db.exec("UPDATE session_message SET data = json_set(data, '$.content[0].text', 'new') WHERE id = 'm'")
        if (conflict === "timestamp") f.db.exec("UPDATE session_message SET time_updated = 999 WHERE id = 'm'")
        if (conflict === "new-message") f.message("new", "user", { content: [{ type: "text", text: "new" }] }, "target", 2)
        if (conflict === "identity") f.request.sessionID = "other"
        if (conflict === "busy") f.db.exec("UPDATE session_v2 SET time_suspended = 123 WHERE id = 'target'")
        if (conflict === "owned") f.db.exec("UPDATE event_sequence SET owner_id = 'replica' WHERE aggregate_id = 'target'")
        if (conflict === "fork") f.db.exec("UPDATE session_v2 SET fork_session_id = 'target' WHERE id = 'other'")
        if (conflict === "tampered-backup") {
          const backup = JSON.parse(readFileSync(result.backupPath!, "utf8"))
          backup.changes[0].original = backup.changes[0].original.replace("readable reasoning", "altered readable reasoning")
          writeFileSync(result.backupPath!, JSON.stringify(backup))
        }
        const before = f.snapshot()
        expect(runCleanup({ ...f.request, operation: "restore", backupPath: result.backupPath }).ok).toBe(false)
        expect(f.snapshot()).toBe(before)
      } finally { f.db.close() }
    })
  }

  test("write lock prevents cleanup; event-only encrypted history is still cleaned", () => {
    const f = fixture()
    try {
      f.message("m", "assistant", assistant([reasoning({ itemId: "reason-1" })]))
      f.event("ended", "session.reasoning.ended.1", { sessionID: "target", state: { reasoningEncryptedContent: "event-secret", itemId: "reason-1" } })
      const before = f.snapshot()
      f.db.exec("BEGIN IMMEDIATE")
      expect(runCleanup(f.request).ok).toBe(false)
      f.db.exec("ROLLBACK")
      expect(f.snapshot()).toBe(before)
      const result = runCleanup(f.request)
      expect(result.ok).toBe(true)
      if (!result.ok) throw Error(result.error)
      expect(result.changedMessages).toBe(1)
      expect(result.changedEvents).toBe(1)
      expect(f.data("session_message", "m").content[0].state).toBeUndefined()
    } finally { f.db.close() }
  })

  test("private backup is required, and failure after backup rolls back all updates", () => {
    const f = fixture()
    try {
      f.message("m", "assistant", assistant())
      mkdirSync(f.request.backupDir, { mode: 0o755 })
      const before = f.snapshot()
      expect(runCleanup(f.request).ok).toBe(false)
      expect(f.snapshot()).toBe(before)
      rmSync(f.request.backupDir, { recursive: true })
      // Preserve pinned columns but force an UPDATE failure via a fixture-only
      // constraint, after the first message UPDATE has succeeded.
      f.db.exec("DROP TABLE event; CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, created integer NOT NULL DEFAULT 0, type text NOT NULL, data text NOT NULL CHECK (instr(data, 'reasoningEncryptedContent') > 0))")
      f.event("fail", "session.reasoning.ended.1", { sessionID: "target", state: { reasoningEncryptedContent: "event-secret", itemId: "reason-1" } })
      const beforeUpdate = f.snapshot()
      expect(runCleanup(f.request).ok).toBe(false)
      expect(f.snapshot()).toBe(beforeUpdate)
      expect(readdirSync(f.request.backupDir)).toHaveLength(1)
    } finally { f.db.close() }
  })

  test("missing database is never created; invalid stdin and args produce one safe JSON error", () => {
    const f = fixture()
    try {
      const missing = join(f.root, "absent.sqlite")
      expect(runCleanup({ ...f.request, dbPath: missing }).ok).toBe(false)
      expect(readdirSync(f.root)).not.toContain("absent.sqlite")
      const helper = join(import.meta.dir, "..", "src", "helper.ts")
      for (const args of [[], ["secret-arg"]]) {
        const child = Bun.spawnSync([process.execPath, helper, ...args], { stdin: Buffer.from("secret-invalid-json"), stdout: "pipe", stderr: "pipe" })
        expect(child.exitCode).toBe(1)
        const output = child.stdout.toString()
        expect(JSON.parse(output).ok).toBe(false)
        expect(output.trim().split("\n")).toHaveLength(1)
        expect(output).not.toContain("secret")
        expect(child.stderr.toString()).toBe("")
      }
    } finally { f.db.close() }
  })
})
