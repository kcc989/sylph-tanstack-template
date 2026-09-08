import { Schema } from "effect"
import {
  RecoveryObjectRequest,
  RecoveryObjectResponse,
  RecoveryObjectSnapshot,
  RecoveryObjectSqlSchema,
  RecoveryObjectSqlColumns,
  RecoveryObjectTableList,
  RecoveryObjectBytes,
  RecoveryObjectInteger,
  RecoveryObjectReal,
  type RecoveryObjectIdentity,
} from "./object-domain"
import { RecoveryGate } from "./domain"

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`

const objectSnapshot = async (
  state: DurableObjectState
): Promise<RecoveryObjectSnapshot> => {
  if (
    state.getWebSockets().length > 0 ||
    (await state.storage.getAlarm()) !== null
  )
    throw new Error("Object recovery does not support alarms or WebSockets")
  const entries = Schema.decodeUnknownSync(RecoveryObjectSqlSchema)([
    ...state.storage.sql.exec(
      "SELECT name, type, sql FROM sqlite_master WHERE name NOT GLOB '_cf_*' ORDER BY name"
    ),
  ])
  if (
    entries.some(
      (entry) =>
        entry.name === "sqlite_sequence" ||
        (entry.type !== "table" && entry.type !== "index") ||
        entry.sql?.toUpperCase().includes("CREATE VIRTUAL TABLE")
    )
  )
    throw new Error("Object schema requires an unsupported restore protocol")
  const tables = entries.filter(
    (entry) => entry.type === "table" && !entry.name.startsWith("sqlite_")
  )
  if (tables.length > 32)
    throw new Error("Object table count exceeds recovery bound")
  const tableList = Schema.decodeUnknownSync(RecoveryObjectTableList)([
    ...state.storage.sql.exec("PRAGMA table_list"),
  ])
  const captured = tables.map((table) => {
    if (!table.sql) throw new Error("Object table schema is missing")
    if (
      [
        ...state.storage.sql.exec(
          `PRAGMA foreign_key_list(${identifier(table.name)})`
        ),
      ].length > 0
    )
      throw new Error("Object recovery does not support foreign keys")
    const columns = Schema.decodeUnknownSync(RecoveryObjectSqlColumns)([
      ...state.storage.sql.exec(
        `PRAGMA table_xinfo(${identifier(table.name)})`
      ),
    ])
    if (columns.some((column) => column.hidden !== 0))
      throw new Error("Object recovery does not support generated columns")
    if (
      columns.some((column) =>
        ["rowid", "_rowid_", "oid"].includes(column.name.toLowerCase())
      )
    )
      throw new Error("Object columns shadow implicit row identity")
    const tableInfo = tableList.find((entry) => entry.name === table.name)
    if (!tableInfo) throw new Error("Object table identity unavailable")
    const rowid = tableInfo.wr === 0
    const largeInteger = columns
      .map(
        (column) =>
          `(typeof(${identifier(column.name)}) = 'integer' AND (${identifier(column.name)} > 9007199254740991 OR ${identifier(column.name)} < -9007199254740991))`
      )
      .join(" OR ")
    if (
      [
        ...state.storage.sql.exec(
          `SELECT 1 FROM ${identifier(table.name)} WHERE ${largeInteger} LIMIT 1`
        ),
      ].length > 0
    )
      throw new Error(
        "Object contains integers outside lossless JavaScript range"
      )
    const rows = [
      ...state.storage.sql
        .exec(
          `SELECT ${columns.map((column) => `typeof(${identifier(column.name)})`).join(",")}, ${rowid ? "CAST(rowid AS TEXT), " : ""}* FROM ${identifier(table.name)} LIMIT 1001`
        )
        .raw(),
    ]
    if (rows.length > 1000)
      throw new Error("Object table exceeds recovery row bound")
    return {
      name: table.name,
      sql: table.sql,
      columns: [
        ...(rowid ? ["rowid"] : []),
        ...columns.map((column) => column.name),
      ],
      rows: rows
        .map((row) => {
          const types = [
            ...(rowid ? ["text"] : []),
            ...row.slice(0, columns.length),
          ]
          return row
            .slice(columns.length)
            .map((value, index) =>
              types[index] === "integer"
                ? { integer: Schema.decodeUnknownSync(Schema.Int)(value) }
                : types[index] === "real"
                  ? { real: Schema.decodeUnknownSync(Schema.Finite)(value) }
                  : value instanceof ArrayBuffer
                    ? { bytes: [...new Uint8Array(value)] }
                    : value
            )
        })
        .sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        ),
    }
  })
  const values = [...(await state.storage.list({ limit: 1001 }))].map(
    ([key, value]) => ({ key, value })
  )
  const snapshot = Schema.decodeUnknownSync(RecoveryObjectSnapshot)({
    version: 1,
    tables: captured,
    indexes: entries
      .filter((entry) => entry.type === "index" && entry.sql !== null)
      .map((entry) => entry.sql),
    values,
  })
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 4194304)
    throw new Error("Object snapshot exceeds 4 MiB")
  return snapshot
}

export const recoverDurableObject = async (
  state: DurableObjectState,
  control: D1Database,
  identity: RecoveryObjectIdentity,
  request: RecoveryObjectRequest,
  afterRestore: () => Promise<void>
): Promise<RecoveryObjectResponse> => {
  const input = Schema.decodeUnknownSync(RecoveryObjectRequest)(request)
  if (
    input.identity.namespaceId !== identity.namespaceId ||
    input.identity.objectId !== identity.objectId ||
    state.id.toString() !== identity.objectId
  )
    throw new Error("Recovery object identity differs")
  const gate = Schema.decodeUnknownSync(RecoveryGate)(
    await control
      .withSession("first-primary")
      .prepare("SELECT owner, active FROM sylph_recovery_gate WHERE id = 1")
      .first()
  )
  if (gate.owner !== input.releaseId || gate.active !== 0)
    throw new Error("Object recovery requires its drained release gate")
  return state.blockConcurrencyWhile(async () => {
    const current = await objectSnapshot(state)
    if (input.operation === "capture") return { identity, snapshot: current }
    const saved = input.snapshot
    const keys = [...(await state.storage.list({ limit: 1001 }))].map(
      ([key]) => key
    )
    state.storage.transactionSync(() => {
      for (const table of current.tables)
        state.storage.sql.exec(`DROP TABLE ${identifier(table.name)}`)
      for (const key of keys) state.storage.kv.delete(key)
      for (const table of saved.tables) {
        state.storage.sql.exec(table.sql)
        for (const row of table.rows)
          state.storage.sql.exec(
            `INSERT INTO ${identifier(table.name)} (${table.columns.map(identifier).join(",")}) VALUES (${row.map((value) => (Schema.is(RecoveryObjectInteger)(value) ? "CAST(? AS INTEGER)" : Schema.is(RecoveryObjectReal)(value) ? "CAST(? AS REAL)" : "?")).join(",")})`,
            ...row.map((value) =>
              Schema.is(RecoveryObjectBytes)(value)
                ? new Uint8Array(value.bytes).buffer
                : Schema.is(RecoveryObjectInteger)(value)
                  ? value.integer
                  : Schema.is(RecoveryObjectReal)(value)
                    ? value.real
                    : value
            )
          )
      }
      for (const sql of saved.indexes) state.storage.sql.exec(sql)
      for (const entry of saved.values)
        state.storage.kv.put(entry.key, entry.value)
    })
    await afterRestore()
    const restored = await objectSnapshot(state)
    if (JSON.stringify(saved) !== JSON.stringify(restored))
      throw new Error("Restored object fingerprint differs")
    return { identity, snapshot: restored }
  })
}

export const withRecoveryObjectGate = async <A>(
  control: D1Database,
  work: () => Promise<A>
): Promise<A> => {
  const database = control.withSession("first-primary")
  const admitted = await database
    .prepare(
      "UPDATE sylph_recovery_gate SET active = active + 1 WHERE id = 1 AND owner IS NULL RETURNING active"
    )
    .first()
  if (!admitted) throw new Error("Application maintenance is in progress")
  try {
    return await work()
  } finally {
    await database
      .prepare(
        "UPDATE sylph_recovery_gate SET active = active - 1 WHERE id = 1 AND active > 0"
      )
      .run()
  }
}
