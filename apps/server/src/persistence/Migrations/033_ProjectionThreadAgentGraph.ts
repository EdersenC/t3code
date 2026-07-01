import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("root_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN root_thread_id TEXT
    `;
  }
  if (!columnNames.has("parent_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN parent_thread_id TEXT
    `;
  }
  if (!columnNames.has("agent_role")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN agent_role TEXT
    `;
  }
  if (!columnNames.has("agent_kind")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN agent_kind TEXT
    `;
  }
  if (!columnNames.has("agent_display_name")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN agent_display_name TEXT
    `;
  }
  if (!columnNames.has("agent_depth")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN agent_depth INTEGER
    `;
  }
  if (!columnNames.has("spawned_by_turn_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN spawned_by_turn_id TEXT
    `;
  }
  if (!columnNames.has("spawned_by_tool_call_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN spawned_by_tool_call_id TEXT
    `;
  }
  if (!columnNames.has("spawn_group_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN spawn_group_id TEXT
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET
      root_thread_id = COALESCE(root_thread_id, thread_id),
      agent_role = COALESCE(agent_role, 'root'),
      agent_kind = COALESCE(agent_kind, 'root'),
      agent_depth = COALESCE(agent_depth, 0)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_agent_root
    ON projection_threads(root_thread_id, deleted_at, agent_depth, created_at, thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_agent_parent
    ON projection_threads(parent_thread_id, deleted_at, created_at, thread_id)
  `;
});
