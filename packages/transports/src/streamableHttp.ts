import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { MetricDefinitions } from "@mongodb-js/mcp-types";
import { TransportRunnerBase } from "./base.js";
import { MCPHttpServer, createDefaultMcpHttpServer } from "./mcpHttpServer.js";
import { MonitoringServer, createDefaultMonitoringServer } from "./monitoringServer.js";
import { createDefaultSessionStore, type SessionStore } from "./sessionStore.js";
import type {
    StreamableHttpRunnerOptions,
    CustomizableServerOptions,
    CustomizableSessionOptions,
    ServerFactory,
    CreateMcpHttpServerFn,
    CreateMonitoringServerFn,
    HttpServerConfig,
    SessionManagementConfig,
    ServerOptions,
} from "./types.js";

export { createDefaultMonitoringServer, MonitoringServer, createDefaultMcpHttpServer, MCPHttpServer };
export type { CreateMonitoringServerFn, CreateMcpHttpServerFn };

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
 * Transport runner for HTTP transport with streamable responses.
 * Supports both SSE and JSON response types.
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
    private mcpServer: MCPHttpServer<TServer, TContext, TMetrics> | undefined;
    private readonly monitoringServer: MonitoringServer<TMetrics> | undefined;
    private readonly sessionStore: InstanceType<typeof SessionStore<StreamableHTTPServerTransport>>;
    private readonly createMcpHttpServer: CreateMcpHttpServerFn<TServer, TContext, TMetrics>;
    private readonly createMonitoringServer?: CreateMonitoringServerFn<TMetrics>;
    private readonly httpConfig: HttpServerConfig;
    private readonly sessionConfig: SessionManagementConfig;

    constructor({
        serverFactory,
        httpServer,
        monitoringServer,
        sessionManagement,
        createSessionStore,
        createMcpHttpServer,
        createMonitoringServer: createMonitoringServerFn,
        loggers,
        metrics,
    }: StreamableHttpRunnerOptions<TMetrics> & {
        serverFactory: ServerFactory<TServer, TContext, TMetrics>;
        createMcpHttpServer?: CreateMcpHttpServerFn<TServer, TContext, TMetrics>;
        createMonitoringServer?: CreateMonitoringServerFn<TMetrics>;
    }) {
        super({ serverFactory, loggers, metrics });

        this.httpConfig = httpServer;
        this.sessionConfig = sessionManagement;
        this.createMcpHttpServer = createMcpHttpServer ?? createDefaultMcpHttpServer;
        this.createMonitoringServer = createMonitoringServerFn;

        // Create session store
        this.sessionStore = (createSessionStore ?? createDefaultSessionStore<StreamableHTTPServerTransport>)({
            options: {
                idleTimeoutMS: sessionManagement.idleTimeoutMs,
                notificationTimeoutMS: sessionManagement.notificationTimeoutMs,
            },
            logger: this.logger,
            metrics: this.metrics,
        }) as InstanceType<typeof SessionStore<StreamableHTTPServerTransport>>;

        // Create monitoring server if configured
        if (monitoringServer) {
            this.monitoringServer = (this.createMonitoringServer ?? createDefaultMonitoringServer)({
                host: monitoringServer.host,
                port: monitoringServer.port,
                features: monitoringServer.features,
                logger: this.logger,
                metrics: this.metrics,
            });
        }
    }

    /** Starts the transport runner. */
    async start({
        serverOptions,
    }: {
        serverOptions?: CustomizableServerOptions<TContext>;
        sessionOptions?: CustomizableSessionOptions;
    } = {}): Promise<void> {
        this.validateConfig();

        // Merge customizable options with base server options
        const mergedOptions: ServerOptions<TContext, TMetrics> = {
            logger: this.logger,
            metrics: this.metrics,
            ...serverOptions,
        } as unknown as ServerOptions<TContext, TMetrics>;

        this.mcpServer = this.createMcpHttpServer({
            httpConfig: this.httpConfig,
            sessionConfig: this.sessionConfig,
            serverFactory: this.serverFactory,
            logger: this.logger,
            metrics: this.metrics,
            sessionStore: this.sessionStore,
            serverOptions: mergedOptions,
        });

        await this.mcpServer.start();

        // Start the monitoring server if one exists
        await this.monitoringServer?.start();

        this.logger.info({
            message: "Streamable HTTP Transport started",
            context: "streamableHttpTransport",
            id: { __value: 10016 }, // LogId.streamableHttpTransportStarted
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
        // Check for potentially unsafe host binding
        if (this.shouldWarnAboutHttpHost(this.httpConfig.host)) {
            this.logger.warning({
                id: { __value: 10017 }, // LogId.streamableHttpTransportHttpHostWarning
                context: "streamableHttpTransport",
                message: `Binding to ${this.httpConfig.host} can expose the MCP Server to the entire local network, which allows other devices on the same network to potentially access the MCP Server. This is a security risk and could allow unauthorized access to your database context.`,
                noRedaction: true,
            });
        }
    }
}
