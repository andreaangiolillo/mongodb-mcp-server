# V2 Migration Guide

## Positional parameters replaced with options objects

All constructors now take a single options object instead of positional arguments.

### `LoggerBase`

```diff
- const logger = new LoggerBase(keychain);
+ const logger = new LoggerBase({ keychain });
```

Classes extending `LoggerBase` must update their `super()` calls accordingly.

### `ConsoleLogger`

```diff
- const logger = new ConsoleLogger(keychain);
+ const logger = new ConsoleLogger({ keychain });
```

### `DiskLogger`

```diff
- const logger = new DiskLogger(logPath, onError, keychain);
+ const logger = new DiskLogger({ logPath, onError, keychain });
```

### `McpLogger`

`McpLogger` now accepts an `McpServer` (from `@mongodb-js/mcp-core`) directly, plus a `mcpLogLevel` (static value or getter function).

```diff
- const logger = new McpLogger(server, keychain);
+ const logger = new McpLogger({
+     server: mcpServer,
+     mcpLogLevel: () => server.mcpLogLevel,
+     keychain,
+ });
```

## Telemetry moved to `@mongodb-js/mcp-atlas-telemetry`

The telemetry implementation has been extracted into a standalone package. All telemetry imports must be updated.

### Package

```diff
- import { Telemetry } from "mongodb-mcp-server";
+ import { AtlasTelemetry } from "@mongodb-js/mcp-atlas-telemetry";
```

### `Telemetry` renamed to `AtlasTelemetry`

```diff
- import { Telemetry } from "mongodb-mcp-server";
+ import { AtlasTelemetry } from "@mongodb-js/mcp-atlas-telemetry";

- const telemetry = Telemetry.create(session, userConfig, deviceId);
+ const telemetry = AtlasTelemetry.create({
+     logger,
+     deviceId,
+     apiClient,
+     keychain,              // now mandatory
+     enabled: true,
+     machineMetadata: buildMachineMetadata(packageName, packageVersion),
+ });
```

`machineMetadata` is now a required field. Use the `buildMachineMetadata(name, version)` helper exported from `@mongodb-js/mcp-atlas-telemetry` to construct it.

### Type renames

All telemetry types are now prefixed with `Telemetry` or `Atlas`:

| Old name                  | New name                             |
| ------------------------- | ------------------------------------ |
| `BaseEvent`               | `TelemetryBaseEvent`                 |
| `CommonProperties`        | `TelemetryCommonProperties`          |
| `CommonStaticProperties`  | `TelemetryCommonStaticProperties`    |
| `TelemetryEvent<T>`       | `TelemetryEvent<T>` (unchanged)      |
| `TelemetryResult`         | `TelemetryResult` (unchanged)        |
| `TelemetryBoolSet`        | `TelemetryBoolSet` (unchanged)       |
| `TelemetryToolMetadata`   | `TelemetryToolMetadata` (unchanged)  |
| `ToolEvent`               | `TelemetryToolEvent`                 |
| `ConnectionMetadata`      | `AtlasConnectionMetadata`            |
| `AtlasMetadata`           | `AtlasMetadata` (unchanged)          |
| `AtlasLocalToolMetadata`  | `AtlasLocalToolMetadata` (unchanged) |
| `PerfAdvisorToolMetadata` | `AtlasPerfAdvisorToolMetadata`       |
| `StreamsToolMetadata`     | `AtlasStreamsToolMetadata`           |
| `SetupStage`              | `TelemetrySetupStage`                |
| `SetupEvent`              | `TelemetrySetupEvent`                |
| `SetupEventProperties`    | `TelemetrySetupEventProperties`      |

### `EventCache` import

```diff
- import { EventCache } from "mongodb-mcp-server";
+ import { EventCache } from "@mongodb-js/mcp-atlas-telemetry";
```

### `NoopTelemetry` added to `@mongodb-js/mcp-core`

A `NoopTelemetry` class implementing `ITelemetry` is now available for use in tests or contexts where telemetry should be silently discarded:

```diff
+ import { NoopTelemetry } from "@mongodb-js/mcp-core";

+ const telemetry = new NoopTelemetry();
```

## Transports moved to `@mongodb-js/mcp-transports`

All transport runners and HTTP server implementations have been extracted into a standalone package. This decouples the transports from the core server implementation and enables better separation of concerns.

### Package

```diff
- import { StdioRunner, StreamableHttpRunner } from "mongodb-mcp-server";
+ import { StdioRunner, StreamableHttpRunner } from "@mongodb-js/mcp-transports";
```

### ServerFactory Pattern

The transport runners no longer depend on the concrete `Server` class. Instead, they accept a `ServerFactory` callback that handles server instantiation. This enables dependency injection and makes the transports reusable with different server implementations.

**Before:**

```typescript
import { StdioRunner, UserConfig } from "mongodb-mcp-server";

const runner = new StdioRunner({
  userConfig, // Full UserConfig required
  // ... other dependencies
});
```

**After:**

```typescript
import { StdioRunner, ServerFactory } from "@mongodb-js/mcp-transports";
import { Server, ServerOptions } from "mongodb-mcp-server";

const serverFactory: ServerFactory = {
  async createServer(options: ServerOptions) {
    // Create and configure your server
    return new Server({
      mcpServer: options.mcpServer,
      session: options.session,
      // ... other options
    });
  },
};

const runner = new StdioRunner({
  serverFactory, // Inject server creation logic
  loggers: [logger],
  metrics,
});
```

### Decoupled from UserConfig

Transport runners no longer require the full `UserConfig` object. Instead, they accept typed configuration options:

| Old (UserConfig field)      | New (typed option)                            |
| --------------------------- | --------------------------------------------- |
| `transport`                 | Runner class selection                        |
| `httpHost`                  | `httpServer.host`                             |
| `httpPort`                  | `httpServer.port`                             |
| `httpBodyLimit`             | `httpServer.bodyLimit`                        |
| `httpHeaders`               | `httpServer.headers`                          |
| `httpResponseType`          | `httpServer.responseType`                     |
| `idleTimeoutMs`             | `sessionManagement.idleTimeoutMs`             |
| `notificationTimeoutMs`     | `sessionManagement.notificationTimeoutMs`     |
| `externallyManagedSessions` | `sessionManagement.externallyManagedSessions` |
| `monitoringServerHost`      | `monitoringServer.host`                       |
| `monitoringServerPort`      | `monitoringServer.port`                       |
| `monitoringServerFeatures`  | `monitoringServer.features`                   |

**StreamableHttpRunner Example:**

```typescript
import { StreamableHttpRunner } from "@mongodb-js/mcp-transports";

const runner = new StreamableHttpRunner({
  serverFactory,
  httpServer: {
    host: "127.0.0.1",
    port: 3000,
    bodyLimit: 1024 * 1024,
    headers: { "x-api-key": "secret" },
    responseType: "sse", // or "json"
  },
  sessionManagement: {
    idleTimeoutMs: 600_000,
    notificationTimeoutMs: 540_000,
    externallyManagedSessions: false,
  },
  monitoringServer: {
    host: "127.0.0.1",
    port: 8080,
    features: ["health-check", "metrics"],
  },
  loggers: [logger],
  metrics,
});
```

### Type Changes

Several types have been moved or renamed:

| Old location                                      | New location                                         |
| ------------------------------------------------- | ---------------------------------------------------- |
| `TransportRunnerConfig`                           | `TransportRunnerBaseOptions`                         |
| `StreamableHttpTransportRunnerConfig`             | `StreamableHttpRunnerOptions`                        |
| `MonitoringServerConfig` (from streamableHttp.ts) | `MonitoringServerConfig` (from types.ts)             |
| `CreateSessionConfigFn`                           | Removed - use `ServerFactory.createServerForRequest` |
| `CustomizableServerOptions`                       | Same name, moved to `@mongodb-js/mcp-transports`     |
| `CustomizableSessionOptions`                      | Same name, moved to `@mongodb-js/mcp-transports`     |

### Removed from Transports

The following items have been removed from the transports package:

- `TransportRunnerConfig.userConfig` - Pass specific options instead
- `TransportRunnerConfig.createConnectionManager` - Use `ServerFactory` pattern
- `TransportRunnerConfig.connectionErrorHandler` - Pass via `sessionOptions`
- `TransportRunnerConfig.createAtlasLocalClient` - Use `sessionOptions`
- `TransportRunnerConfig.createSessionConfig` - Use `ServerFactory.createServerForRequest`
- `TransportRunnerConfig.createApiClient` - Use `sessionOptions`
- `TransportRunnerConfig.tools` - Pass via `serverOptions`
- `TransportRunnerConfig.telemetryProperties` - Pass via `serverOptions`

### HTTP Servers

The HTTP server implementations are now available from the new package:

```diff
- import { MCPHttpServer, MonitoringServer } from "mongodb-mcp-server";
+ import { MCPHttpServer, MonitoringServer } from "@mongodb-js/mcp-transports";
```

Both servers now accept typed configuration options instead of `UserConfig`:

```typescript
import {
  MCPHttpServer,
  createDefaultMcpHttpServer,
} from "@mongodb-js/mcp-transports";

const httpServer = createDefaultMcpHttpServer({
  httpConfig: { host, port, bodyLimit, headers, responseType },
  sessionConfig: {
    idleTimeoutMs,
    notificationTimeoutMs,
    externallyManagedSessions,
  },
  serverFactory,
  logger,
  metrics,
  sessionStore,
  serverOptions,
});
```

### Session Store

The session store interface and implementation have been moved:

```diff
- import { ISessionStore, createDefaultSessionStore } from "mongodb-mcp-server";
+ import { ISessionStore, createDefaultSessionStore } from "@mongodb-js/mcp-transports";
```

### InMemoryTransport

The in-memory transport is now available from the new package:

```diff
- import { InMemoryTransport } from "mongodb-mcp-server";
+ import { InMemoryTransport } from "@mongodb-js/mcp-transports";
```

### Error Codes

JSON-RPC error codes are now exported from the transports package:

```diff
- import { JSON_RPC_ERROR_CODE_SESSION_NOT_FOUND } from "mongodb-mcp-server";
+ import { JSON_RPC_ERROR_CODE_SESSION_NOT_FOUND } from "@mongodb-js/mcp-transports";
```
