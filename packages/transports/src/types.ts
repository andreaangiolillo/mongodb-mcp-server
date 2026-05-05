import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ILogger, ICompositeLogger, IKeychain } from "@mongodb-js/mcp-types";
import type { IMetrics, MetricDefinitions } from "@mongodb-js/mcp-types";
import type { TransportRequestContext } from "@mongodb-js/mcp-types";
import type { LogLevel } from "@mongodb-js/mcp-core";

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
 * Base configuration options for all transport runners.
 */
export type TransportRunnerBaseOptions<TMetrics extends MetricDefinitions = MetricDefinitions> = {
    /**
     * Server factory for creating server instances.
     */
    serverFactory: ServerFactory<unknown, unknown, TMetrics>;

    /** Optional metrics instance */
    metrics?: IMetrics<TMetrics>;

    /** Optional loggers to use */
    loggers?: ILogger[];
};

/**
 * Configuration for the StdioRunner.
 */
export type StdioRunnerOptions<TMetrics extends MetricDefinitions = MetricDefinitions> =
    TransportRunnerBaseOptions<TMetrics>;

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

export type { TransportRequestContext, MetricDefinitions } from "@mongodb-js/mcp-types";
