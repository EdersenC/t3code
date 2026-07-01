import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import * as McpProviderSession from "./McpProviderSession.ts";

const config: McpProviderSession.McpProviderSessionConfig = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "global",
  providerInstanceId: ProviderInstanceId.make("codex"),
  endpoint: "http://127.0.0.1:13774/mcp?threadId=thread-1&providerInstanceId=codex",
  authorizationHeader: "Bearer token-1",
};

it("builds the shared Codex MCP environment and app-server args", () => {
  assert.deepEqual(
    McpProviderSession.codexMcpEnvironment(config, {
      EXISTING: "1",
    }),
    {
      EXISTING: "1",
      T3_MCP_BEARER_TOKEN: "token-1",
    },
  );

  assert.deepEqual(McpProviderSession.codexMcpAppServerArgs(config), [
    "-c",
    "mcp_servers.t3-code.url=http://127.0.0.1:13774/mcp?threadId=thread-1&providerInstanceId=codex",
    "-c",
    'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
  ]);
});

it("builds the shared Claude MCP server map", () => {
  assert.deepEqual(McpProviderSession.claudeMcpServers(config), {
    "t3-code": {
      type: "http",
      url: config.endpoint,
      headers: {
        Authorization: "Bearer token-1",
      },
    },
  });
});

it("builds the shared ACP MCP server descriptor", () => {
  assert.deepEqual(McpProviderSession.acpMcpServer(config), {
    type: "http",
    name: "t3-code",
    url: config.endpoint,
    headers: [
      {
        name: "Authorization",
        value: "Bearer token-1",
      },
    ],
  });
});

it("builds the shared OpenCode MCP add input", () => {
  assert.deepEqual(McpProviderSession.openCodeMcpAddInput(config), {
    name: "t3-code",
    config: {
      type: "remote",
      url: config.endpoint,
      headers: {
        Authorization: "Bearer token-1",
      },
      oauth: false,
    },
  });
});
