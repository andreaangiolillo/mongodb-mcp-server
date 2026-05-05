/**
 * Core types and interfaces for the mcp-transports package.
 * Provides ServerFactory pattern and typed options for decoupling from UserConfig.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ILogger, ICompositeLogger, IKeychain } from "@mongodb-js/mcp-types";
import type { IMetrics, MetricDefinitions } from "@mongodb-js/mcp-types";
import type { TransportRequestContext, CloseableTransport, SessionCloseReason } from "@mongodb-js/mcp-types";
import type { LogLevel } from "@mongodb-js/mcp-core";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { MCPHttpServer } from "./mcpHttpServer.js";
import type { MonitoringServer } from "./monitoringServer.js";

/**
 * Options for creating an MCP server instance.
 * Decoupled from UserConfig to allow flexible configuration.
 */
export type ServerOptions<TContext = unknown, TMetrics extends MetricDefinitions = MetricDefinitions> = {
    /** MCP Server instance */
    mcpServer: McpServer;
    /** Logger for the server */
    logger: ICompositeLogger;
    /** Metrics instance for tracking server metrics */
    metrics?: IMetrics<TMetrics>;
    /** Custom tool context */
    toolContext?: TContext;
    /** Log level for MCP client */
    mcpLogLevel?: LogLevel;
    /** Server name */
    name?: string;
    /** Server version */
    version?: string;
};

/**
 * Options for creating a session.
 * Decoupled from UserConfig to allow flexible configuration.
 */
export type SessionOptions = {
    /** Logger for the session */
    logger: ICompositeLogger;
    /** Session ID */
    sessionId?: string;
    /** API client for external services */
    apiClient?: unknown;
    /** Atlas local client */
    atlasLocalClient?: unknown;
    /** Connection manager for MongoDB */
    connectionManager?: unknown;
    /** Error handler for connection errors */
    connectionErrorHandler?: unknown;
    /** Keychain for secrets */
    keychain?: IKeychain;
};

/**
 * Factory interface for creating server instances.
 * This decouples the transports from the concrete Server class.
 */
export interface ServerFactory<
    TServer = unknown,
    TContext = unknown,
    TMetrics extends MetricDefinitions = MetricDefinitions,
> {
    /**
     * Creates a server instance for stdio transport.
     */
    createServer(options: ServerOptions<TContext, TMetrics>): Promise<TServer>;

    /**
     * Creates a server instance for a specific HTTP request.
     */
    createServerForRequest?(
        options: ServerOptions<TContext, TMetrics> & { request: TransportRequestContext }
    ): Promise<TServer>;
}

/**
 * Callback type for server factory injection.
 */
export type CreateServerFn<
    TServer = unknown,
    TContext = unknown,
    TMetrics extends MetricDefinitions = MetricDefinitions,
> = (options: ServerOptions<TContext, TMetrics>) => Promise<TServer>;

/**
 * Callback type for creating a server for a specific request.
 */
export type CreateServerForRequestFn<
    TServer = unknown,
    TContext = unknown,
    TMetrics extends MetricDefinitions = MetricDefinitions,
> = (options: ServerOptions<TContext, TMetrics> & { request: TransportRequestContext }) => Promise<TServer>;

/**
 * Base configuration options for all transport runners.
 * Decoupled from UserConfig - accepts typed options instead.
 */
export type TransportRunnerBaseOptions<TMetrics extends MetricDefinitions = MetricDefinitions> = {
    /**
     * Server factory callback for creating server instances.
     * This is the primary way to inject server creation logic.
     */
    serverFactory: ServerFactory<unknown, unknown, TMetrics>;

    /** Optional metrics instance */
    metrics?: IMetrics<TMetrics>;

    /** Optional loggers to use */
    loggers?: ILogger[];

    /**
     * Session store factory for HTTP transports.
     * If not provided, a default in-memory session store is used.
     */
    createSessionStore?: CreateSessionStoreFn<CloseableTransport, TMetrics>;
};

/**
 * Configuration for the StdioRunner.
 */
export type StdioRunnerOptions<TMetrics extends MetricDefinitions = MetricDefinitions> =
    TransportRunnerBaseOptions<TMetrics>;

/**
 * Configuration for the HTTP server (host, port, etc).
 */
export type HttpServerConfig = {
    /** Host to bind the HTTP server to */
    host: string;
    /** Port to bind the HTTP server to */
    port: number;
    /** Maximum HTTP body size in bytes */
    bodyLimit?: number;
    /** Headers to validate */
    headers?: Record<string, string>;
    /** Response type: 'sse' for Server-Sent Events, 'json' for JSON responses */
    responseType?: "sse" | "json";
};

/**
 * Configuration for the monitoring server.
 */
export type MonitoringServerConfig = {
    /** Host to bind the monitoring server to */
    host: string;
    /** Port to bind the monitoring server to */
    port: number;
    /** Features to enable on the monitoring server */
    features: MonitoringServerFeature[];
};

/**
 * Features available on the monitoring server.
 */
export type MonitoringServerFeature = "health-check" | "metrics";

/**
 * Configuration for session management.
 */
export type SessionManagementConfig = {
    /** Idle timeout in milliseconds */
    idleTimeoutMs: number;
    /** Notification timeout in milliseconds */
    notificationTimeoutMs: number;
    /** Whether to allow externally managed sessions */
    externallyManagedSessions: boolean;
};

/**
 * Configuration for the StreamableHttpRunner.
 */
export type StreamableHttpRunnerOptions<TMetrics extends MetricDefinitions = MetricDefinitions> =
    TransportRunnerBaseOptions<TMetrics> & {
        /** HTTP server configuration */
        httpServer: HttpServerConfig;
        /** Optional monitoring server configuration */
        monitoringServer?: MonitoringServerConfig;
        /** Session management configuration */
        sessionManagement: SessionManagementConfig;
    };

/**
 * Configuration for the DryRunModeRunner.
 */
export type DryRunModeRunnerOptions<TMetrics extends MetricDefinitions = MetricDefinitions> =
    TransportRunnerBaseOptions<TMetrics> & {
        /** Console logger for outputting config and tools */
        consoleLogger: {
            log(message: string): void;
            error(message: string): void;
        };
    };

/**
 * Constructor arguments for creating an MCPHttpServer instance.
 */
export type MCPHttpServerConstructorArgs<
    TServer = unknown,
    TContext = unknown,
    TMetrics extends MetricDefinitions = MetricDefinitions,
> = {
    /** HTTP server configuration */
    httpConfig: HttpServerConfig;
    /** Session management configuration */
    sessionConfig: SessionManagementConfig;
    /** Server factory for creating server instances */
    serverFactory: ServerFactory<TServer, TContext, TMetrics>;
    /** Logger for the server */
    logger: ICompositeLogger;
    /** Metrics instance */
    metrics: IMetrics<TMetrics>;
    /** Session store for managing transports */
    sessionStore: ISessionStore<StreamableHTTPServerTransport>;
    /** Optional server options to pass to factory */
    serverOptions?: ServerOptions<TContext, TMetrics>;
};

/**
 * A function to create a custom MCPHttpServer instance.
 */
export type CreateMcpHttpServerFn<
    TServer = unknown,
    TContext = unknown,
    TMetrics extends MetricDefinitions = MetricDefinitions,
> = (args: MCPHttpServerConstructorArgs<TServer, TContext, TMetrics>) => MCPHttpServer<TServer, TContext, TMetrics>;

/**
 * Constructor arguments for creating a MonitoringServer instance.
 */
export type MonitoringServerConstructorArgs<TMetrics extends MetricDefinitions = MetricDefinitions> = {
    host: string;
    port: number;
    features: MonitoringServerFeature[];
    logger: ILogger;
    metrics: IMetrics<TMetrics>;
};

/**
 * A function to create a custom MonitoringServer instance.
 */
export type CreateMonitoringServerFn<TMetrics extends MetricDefinitions = MetricDefinitions> = (
    args: MonitoringServerConstructorArgs<TMetrics>
) => MonitoringServer<TMetrics> | undefined;

/**
 * Interface for managing MCP transport sessions.
 */
export interface ISessionStore<T extends CloseableTransport = CloseableTransport> {
    getSession(sessionId: string): Promise<T | undefined>;
    addSession(params: { sessionId: string; transport: T; logger: ILogger }): Promise<void>;
    closeSession(params: { sessionId: string; reason?: SessionCloseReason }): Promise<void>;
    closeAllSessions(): Promise<void>;
}

/**
 * Constructor arguments for creating a SessionStore instance.
 */
export type SessionStoreConstructorArgs<TMetrics extends MetricDefinitions = MetricDefinitions> = {
    options: { idleTimeoutMS: number; notificationTimeoutMS: number };
    logger: ILogger;
    metrics: IMetrics<TMetrics>;
};

/**
 * A function to create a custom SessionStore instance.
 */
export type CreateSessionStoreFn<
    TTransport extends CloseableTransport = CloseableTransport,
    TMetrics extends MetricDefinitions = MetricDefinitions,
> = (args: SessionStoreConstructorArgs<TMetrics>) => ISessionStore<TTransport>;

/**
 * Options that can be customized when starting a runner.
 */
export type CustomizableServerOptions<TContext = unknown> = {
    /** Custom tool context */
    toolContext?: TContext;
    /** Telemetry properties */
    telemetryProperties?: Record<string, string>;
};

/**
 * Options that can be customized for sessions when starting a runner.
 */
export type CustomizableSessionOptions = {
    /** API client instance */
    apiClient?: unknown;
    /** Atlas local client instance */
    atlasLocalClient?: unknown;
    /** Connection manager instance */
    connectionManager?: unknown;
    /** Connection error handler */
    connectionErrorHandler?: unknown;
};

export type { TransportRequestContext, CloseableTransport, SessionCloseReason, MetricDefinitions };
