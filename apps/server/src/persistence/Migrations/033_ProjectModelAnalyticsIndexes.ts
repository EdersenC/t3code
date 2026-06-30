import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_deleted_thread
    ON projection_threads(project_id, deleted_at, thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_kind_thread_turn_sequence
    ON projection_thread_activities(kind, thread_id, turn_id, sequence, created_at, activity_id)
  `;
});
