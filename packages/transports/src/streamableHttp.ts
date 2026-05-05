import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { MetricDefinitions, ISessionStore } from "@mongodb-js/mcp-types";
import { LogId } from "@mongodb-js/mcp-core";
import { TransportRunnerBase } from "./base.js";
import { MCPHttpServer } from "./mcpHttpServer.js";
import { MonitoringServer } from "./monitoringServer.js";
import type {
    CustomizableServerOptions,
    CustomizableSessionOptions,
    ServerFactory,
} from "./types.js";

export { MonitoringServer, MCPHttpServer };

// Re-export error codes
export {
    JSON_RPC_ERROR_CODE_PROCESSING_REQUEST_FAILED,
    JSON_RPC_ERROR_CODE_SESSION_ID_REQUIRED,
    JSON_RPC_ERROR_CODE_SESSION_ID_INVALID,
    JSON_RPC_ERROR_CODE_SESSION_NOT_FOUND,
    JSON_RPC_ERROR_CODE_INVALID_REQUEST,
    JSON_RPC_ERROR_CODE_DISALLOWED_EXTERNAL_SESSION,
} from "./jsonRpcErrorCodes.js";

/**
 * Options for StreamableHttpRunner.
 */
export type StreamableHttpRunnerOptions<
    TServer = unknown,
    TContext = unknown,
    TMetrics extends MetricDefinitions = MetricDefinitions,
> = {
    /**
     * Server factory for creating server instances.
     */
    serverFactory: ServerFactory<TServer, TContext, TMetrics>;

    /**
     * The MCP HTTP server instance.
     * This is provided as a dependency for inversion of control.
     */
    mcpHttpServer: MCPHttpServer<TServer, TContext, TMetrics>;

    /**
     * Optional monitoring server instance.
     */
    monitoringServer?: MonitoringServer<TMetrics>;

    /** Optional loggers to use */
    loggers?: import("@mongodb-js/mcp-types").ILogger[];

    /** Optional metrics instance */
    metrics?: import("@mongodb-js/mcp-types").IMetrics<TMetrics>;
};

/**
 * Transport runner for HTTP transport with streamable responses.
 * Supports both SSE and JSON response types.
 * Servers are passed directly as dependencies instead of being created internally.
 */
export class StreamableHttpRunner<
    TServer extends {
        connect(transport: StreamableHTTPServerTransport): Promise<void>;
        close(): Promise<void>;
        session?: { logger: { setAttribute(key: string, value: string): void } };
    } = {
        connect(transport: StreamableHTTPServerTransport): Promise<void>;
        close(): Promise<void>;
        session?: { logger: { setAttribute(key: string, value: string): void } };
    },
    TContext = unknown,
    TMetrics extends MetricDefinitions = MetricDefinitions,
> extends TransportRunnerBase<TServer, TContext, TMetrics> {
    private mcpServer: MCPHttpServer<TServer, TContext, TMetrics>;
    private readonly monitoringServer: MonitoringServer<TMetrics> | undefined;

    constructor({
        serverFactory,
        mcpHttpServer,
        monitoringServer,
        loggers,
        metrics,
    }: StreamableHttpRunnerOptions<TServer, TContext, TMetrics>) {
        super({ serverFactory, loggers, metrics });

        this.mcpServer = mcpHttpServer;
        this.monitoringServer = monitoringServer;
    }

    /** Starts the transport runner. */
    async start({
        serverOptions,
    }: {
        serverOptions?: CustomizableServerOptions<TContext>;
        sessionOptions?: CustomizableSessionOptions;
    } = {}): Promise<void> {
        this.validateConfig();

        await this.mcpServer.start();

        // Start the monitoring server if one exists
        await this.monitoringServer?.start();

        this.logger.info({
            message: "Streamable HTTP Transport started",
            context: "streamableHttpTransport",
            id: LogId.streamableHttpTransportStarted,
        });
    }

    async closeTransport(): Promise<void> {
        await Promise.all([this.mcpServer?.stop(), this.monitoringServer?.stop()]);
    }

    private shouldWarnAboutHttpHost(httpHost: string): boolean {
        const host = httpHost.trim();
        const safeHosts = new Set(["127.0.0.1", "localhost", "::1"]);
        return host === "0.0.0.0" || host === "::" || (!safeHosts.has(host) && host !== "");
    }

    private validateConfig(): void {
        // Get the HTTP config from the mcp server to validate
        const httpConfig = this.mcpServer.httpConfig;

        // Check for potentially unsafe host binding
        if (this.shouldWarnAboutHttpHost(httpConfig.host)) {
            this.logger.warning({
                id: LogId.streamableHttpTransportHttpHostWarning,
                context: "streamableHttpTransport",
                message: `Binding to ${httpConfig.host} can expose the MCP Server to the entire local network, which allows other devices on the same network to potentially access the MCP Server. This is a security risk and could allow unauthorized access to your database context.`,
                noRedaction: true,
            });
        }
    }
}
