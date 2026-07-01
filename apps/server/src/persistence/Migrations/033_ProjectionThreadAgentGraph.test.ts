import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("033_ProjectionThreadAgentGraph", (it) => {
  it.effect("backfills existing projection threads as root sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES
          (
            'thread-root-a',
            'project-1',
            'Existing A',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-02-24T00:00:00.000Z',
            '2026-02-24T00:00:00.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
            NULL
          ),
          (
            'thread-root-b',
            'project-1',
            'Existing B',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-02-24T00:01:00.000Z',
            '2026-02-24T00:01:00.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
            NULL
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 33 });

      const rows = yield* sql<{
        readonly thread_id: string;
        readonly root_thread_id: string;
        readonly parent_thread_id: string | null;
        readonly agent_role: string;
        readonly agent_kind: string;
        readonly agent_depth: number;
      }>`
        SELECT
          thread_id,
          root_thread_id,
          parent_thread_id,
          agent_role,
          agent_kind,
          agent_depth
        FROM projection_threads
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(rows, [
        {
          thread_id: "thread-root-a",
          root_thread_id: "thread-root-a",
          parent_thread_id: null,
          agent_role: "root",
          agent_kind: "root",
          agent_depth: 0,
        },
        {
          thread_id: "thread-root-b",
          root_thread_id: "thread-root-b",
          parent_thread_id: null,
          agent_role: "root",
          agent_kind: "root",
          agent_depth: 0,
        },
      ]);
    }),
  );
});
