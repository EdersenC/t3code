import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export const T3_MCP_SERVER_NAME = "t3-code";
export const T3_MCP_AUTHORIZATION_HEADER = "Authorization";
export const T3_MCP_BEARER_TOKEN_ENV_VAR = "T3_MCP_BEARER_TOKEN";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}

export function codexMcpEnvironment(
  config: McpProviderSessionConfig,
  baseEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...baseEnvironment,
    [T3_MCP_BEARER_TOKEN_ENV_VAR]: config.authorizationHeader.replace(/^Bearer\s+/, ""),
  };
}

export function codexMcpAppServerArgs(config: McpProviderSessionConfig): ReadonlyArray<string> {
  return [
    "-c",
    `mcp_servers.${T3_MCP_SERVER_NAME}.url=${config.endpoint}`,
    "-c",
    `mcp_servers.${T3_MCP_SERVER_NAME}.bearer_token_env_var="${T3_MCP_BEARER_TOKEN_ENV_VAR}"`,
  ];
}

export function claudeMcpServers(config: McpProviderSessionConfig): Record<
  typeof T3_MCP_SERVER_NAME,
  {
    readonly type: "http";
    readonly url: string;
    readonly headers: Record<typeof T3_MCP_AUTHORIZATION_HEADER, string>;
  }
> {
  return {
    [T3_MCP_SERVER_NAME]: {
      type: "http",
      url: config.endpoint,
      headers: {
        [T3_MCP_AUTHORIZATION_HEADER]: config.authorizationHeader,
      },
    },
  };
}

export function acpMcpServer(config: McpProviderSessionConfig): {
  readonly type: "http";
  readonly name: typeof T3_MCP_SERVER_NAME;
  readonly url: string;
  readonly headers: ReadonlyArray<{
    readonly name: typeof T3_MCP_AUTHORIZATION_HEADER;
    readonly value: string;
  }>;
} {
  return {
    type: "http",
    name: T3_MCP_SERVER_NAME,
    url: config.endpoint,
    headers: [
      {
        name: T3_MCP_AUTHORIZATION_HEADER,
        value: config.authorizationHeader,
      },
    ],
  };
}

export function openCodeMcpAddInput(config: McpProviderSessionConfig): {
  readonly name: typeof T3_MCP_SERVER_NAME;
  readonly config: {
    readonly type: "remote";
    readonly url: string;
    readonly headers: Record<typeof T3_MCP_AUTHORIZATION_HEADER, string>;
    readonly oauth: false;
  };
} {
  return {
    name: T3_MCP_SERVER_NAME,
    config: {
      type: "remote",
      url: config.endpoint,
      headers: {
        [T3_MCP_AUTHORIZATION_HEADER]: config.authorizationHeader,
      },
      oauth: false,
    },
  };
}
