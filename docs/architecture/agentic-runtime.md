# Agentic Runtime

T3 Code models agents as a graph of orchestration threads. There is no separate
agent store: projects, sessions, messages, activities, provider sessions, and
subagents are all replayed from the existing orchestration event log and
projection tables.

## Terms

- Project: a workspace/repository container.
- Root session: the first user-facing conversation for a project task.
- Root agent: the agent conversation attached to the root session thread.
- Subagent: a child agent conversation attached to the same root session.
- Agent thread: any thread with agent metadata. Existing threads without durable
  parent metadata are interpreted as root agents.

## Thread Graph

Every thread has agent metadata in the projected read model:

- `rootThreadId`: the root session thread for the graph.
- `parentThreadId`: set only for subagents.
- `agentRole`: `root` or `subagent`.
- `agentKind`: `root`, `explore`, `implement`, `review`, or `custom`.
- `depth`: root is `0`; a child is parent depth plus one.
- `spawnedByTurnId`, `spawnedByToolCallId`, and `spawnGroupId`: provenance for
  tracing fanout back to the exact turn/tool call.

The decider validates that child agents stay in the same project, point at a
valid root, do not parent themselves, and stay inside the default graph limits.
The T3 subagent runtime applies the configured server limits before it emits
child thread creation commands.

## MCP And Queue Isolation

Subagents inherit the parent/root project, provider model selection, runtime
mode, interaction mode, branch, worktree path, and MCP session family unless a
future override is explicitly added. Each child still gets its own thread id and
queue key. Parent turns do not block on child execution; child results are
reported through durable activities and can be delivered back to the parent by
normal turn dispatch.

Recursive subagents are just child threads spawning more child threads. Depth,
children-per-agent, and active-agent-per-session limits prevent runaway trees.

## Direct Messaging

The UI sends messages to a selected subagent through the normal
`thread.turn.start` command with the child thread id. There is no separate
"message subagent" protocol. The root session remains discoverable because the
child thread carries `rootThreadId` and `parentThreadId`.

## Tracing

Agent events and activities should carry a trace context equivalent to:

```ts
{
  projectId,
  rootThreadId,
  threadId,
  parentThreadId,
  agentKind,
  depth,
  turnId,
  spawnGroupId,
  toolCallId,
  toolCallGroupId,
  providerInstanceId,
  correlationId,
  timestamp,
}
```

The orchestration event layer uses `commandId` as the correlation id. Runtime
activities that are not direct orchestration commands use the provider event id
or a T3-generated spawn id as the correlation id.

## Grouped Tool Calls

Grouped tool calls are not only visual grouping. A group with policy `barrier`
buffers tool results at the tool-result boundary until every expected item has a
terminal status. The grouped payload is flushed once in stable order:

```ts
{
  groupId,
  results: [
    { toolCallId, toolName, status, content, error }
  ]
}
```

Failed, denied, timed-out, and cancelled items are terminal. They do not flush
early; the model receives one combined result after all expected items are
terminal. Ungrouped tool calls keep the immediate path.

Grouped tool-call events should carry a trace context equivalent to:

```ts
{
  projectId,
  rootThreadId,
  threadId,
  turnId,
  toolCallGroupId,
  toolCallId,
  groupPolicy,
  status,
  correlationId,
  timestamp,
}
```

## Lifecycle Controls

Lifecycle controls are wrappers over normal orchestration commands:

- interrupt one agent: `thread.turn.interrupt` for that thread.
- interrupt descendants: the server resolves the agent tree and dispatches
  interrupt commands for the selected node and descendants.
- archive/hidden: `thread.archive` for the selected agent, with optional
  cascade.
- retry failed turn: re-dispatches the selected agent thread's latest user
  message only when that selected thread is failed or interrupted.

Sibling agents are unaffected unless cascade is explicitly requested.

## Limits

Server settings expose safe defaults:

- `maxAgentDepth`
- `maxChildrenPerAgent`
- `maxActiveAgentsPerSession`
- `maxToolCallsPerGroup`
- `defaultToolGroupTimeoutMs`
- `maxToolGroupTimeoutMs`

The runtime enforces these limits before spawning agents or opening grouped
tool barriers. Limit failures are reported as structured rejections/failure
activities with trace context where a parent thread exists.

## Migration

Migration `033_ProjectionThreadAgentGraph` adds graph columns to
`projection_threads`. Existing rows are backfilled as root sessions:

- `root_thread_id = thread_id`
- `agent_role = root`
- `agent_kind = root`
- `agent_depth = 0`

Old parent/child relationships are not guessed. Durable links are used only
when already present.
