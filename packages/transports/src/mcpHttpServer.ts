import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import type {
    ILogger,
    ICompositeLogger,
    IMetrics,
    MetricDefinitions,
    TransportRequestContext,
} from "@mongodb-js/mcp-types";
import { ExpressBasedHttpServer } from "./expressBasedHttpServer.js";
import {
    JSON_RPC_ERROR_CODE_SESSION_ID_REQUIRED,
    JSON_RPC_ERROR_CODE_SESSION_ID_INVALID,
    JSON_RPC_ERROR_CODE_INVALID_REQUEST,
    JSON_RPC_ERROR_CODE_SESSION_NOT_FOUND,
    JSON_RPC_ERROR_CODE_DISALLOWED_EXTERNAL_SESSION,
    JSON_RPC_ERROR_CODE_PROCESSING_REQUEST_FAILED,
} from "./jsonRpcErrorCodes.js";
import type {
    ISessionStore,
    HttpServerConfig,
    SessionManagementConfig,
    ServerFactory,
    ServerOptions,
} from "./types.js";

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
 * HTTP server that handles MCP requests over HTTP using the Streamable HTTP transport.
 */
export class MCPHttpServer<
    TServer = unknown,
    TContext = unknown,
    TMetrics extends MetricDefinitions = MetricDefinitions,
> extends ExpressBasedHttpServer {
    private readonly sessionStore: ISessionStore<StreamableHTTPServerTransport>;
    private readonly serverOptions?: ServerOptions<TContext, TMetrics>;
    protected readonly httpConfig: HttpServerConfig;
    protected readonly sessionConfig: SessionManagementConfig;
    private readonly metrics: IMetrics<TMetrics>;
    private readonly serverFactory: ServerFactory<TServer, TContext, TMetrics>;
    private readonly pendingInitializations = new Map<string, Promise<void>>();

    constructor({
        httpConfig,
        sessionConfig,
        serverFactory,
        logger,
        metrics,
        sessionStore,
        serverOptions,
    }: MCPHttpServerConstructorArgs<TServer, TContext, TMetrics>) {
        super({
            port: httpConfig.port,
            hostname: httpConfig.host,
            logger,
            logContext: "mcpHttpServer",
        });
        this.httpConfig = httpConfig;
        this.sessionConfig = sessionConfig;
        this.serverFactory = serverFactory;
        this.serverOptions = serverOptions;
        this.metrics = metrics;
        this.sessionStore = sessionStore;
    }

    public async stop(): Promise<void> {
        await Promise.all([this.sessionStore.closeAllSessions(), super.stop()]);
    }

    private reportSessionError(res: express.Response, errorCode: number): void {
        let message: string;
        let statusCode = 400;

        switch (errorCode) {
            case JSON_RPC_ERROR_CODE_SESSION_ID_REQUIRED:
                message = "session id is required";
                break;
            case JSON_RPC_ERROR_CODE_SESSION_ID_INVALID:
                message = "session id is invalid";
                break;
            case JSON_RPC_ERROR_CODE_INVALID_REQUEST:
                message = "invalid request";
                break;
            case JSON_RPC_ERROR_CODE_SESSION_NOT_FOUND:
                message = "session not found";
                statusCode = 404;
                break;
            case JSON_RPC_ERROR_CODE_DISALLOWED_EXTERNAL_SESSION:
                message = "cannot provide sessionId when externally managed sessions are disabled";
                break;
            default:
                message = "unknown error";
                statusCode = 500;
        }
        res.status(statusCode).json({
            jsonrpc: "2.0",
            error: {
                code: errorCode,
                message,
            },
        });
    }

    private startKeepAliveLoop(
        transport: StreamableHTTPServerTransport,
        server: TServer & { session?: { logger: ILogger } }
    ): NodeJS.Timeout | undefined {
        if (this.httpConfig.responseType === "json") {
            // Don't start the ping loop for JSON response type since the connection is short-lived and pings aren't needed
            return undefined;
        }

        let failedPings = 0;
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        const keepAliveLoop = setInterval(async () => {
            try {
                server.session?.logger.debug({
                    id: { __value: 10008 }, // LogId.streamableHttpTransportKeepAlive
                    context: "streamableHttpTransport",
                    message: "Sending ping",
                });

                await transport.send({
                    jsonrpc: "2.0",
                    method: "ping",
                });
                failedPings = 0;
            } catch (err) {
                try {
                    failedPings++;
                    server.session?.logger.warning({
                        id: { __value: 10009 }, // LogId.streamableHttpTransportKeepAliveFailure
                        context: "streamableHttpTransport",
                        message: `Error sending ping (attempt #${failedPings}): ${err instanceof Error ? err.message : String(err)}`,
                    });

                    if (failedPings > 3) {
                        clearInterval(keepAliveLoop);
                        await transport.close();
                    }
                } catch {
                    // Ignore the error of the transport close as there's nothing else
                    // we can do at this point.
                }
            }
        }, 30_000);

        return keepAliveLoop;
    }

    /**
     * Generates a random UUID for session IDs.
     */
    private getRandomUUID(): string {
        return crypto.randomUUID();
    }

    /**
     * Ensures the session for the given sessionId is initialized, serializing
     * concurrent initialization attempts so only one runs at a time.
     */
    private async ensureSessionInitialized({
        req,
        sessionId: providedSessionId,
        isImplicitInitialization,
    }: {
        req: express.Request;
        sessionId?: string;
        isImplicitInitialization: boolean;
    }): Promise<string> {
        /** StreamableHTTPTransport needs to be imported dynamically as it uses Node-specific APIs */
        const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

        const sessionId = providedSessionId ?? this.getRandomUUID();

        // Check if session already exists
        if (await this.sessionStore.getSession(sessionId)) {
            return sessionId;
        }

        // Serialize initializations: if another request is initializing, wait for it
        const pendingInit = this.pendingInitializations.get(sessionId);
        if (pendingInit) {
            this.logger.debug({
                id: { __value: 10010 }, // LogId.streamableHttpTransportSessionNotFound
                context: "streamableHttpTransport",
                message: `Session with ID ${sessionId} is already being initialized, waiting`,
            });
            try {
                await pendingInit;
            } catch {
                // The initializer handles its own error; we just need to
                // let the caller re-check the store.
            }
            return sessionId;
        }

        this.logger.debug({
            id: { __value: 10010 }, // LogId.streamableHttpTransportSessionNotFound
            context: "streamableHttpTransport",
            message: `Session with ID ${sessionId} not found, initializing new session`,
        });

        const initPromise = (async (): Promise<void> => {
            const request: TransportRequestContext = {
                headers: req.headers as Record<string, string | string[] | undefined>,
                query: req.query as Record<string, string | string[] | undefined>,
            };

            // Use serverFactory to create server for this request
            const server =
                (await this.serverFactory.createServerForRequest?.({
                    ...this.serverOptions,
                    request,
                } as ServerOptions<TContext, TMetrics> & { request: TransportRequestContext })) ??
                (await this.serverFactory.createServer(
                    this.serverOptions ?? ({} as ServerOptions<TContext, TMetrics>)
                ));

            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: (): string => sessionId,
                enableJsonResponse: this.httpConfig.responseType === "json",
                onsessionclosed: async (sid): Promise<void> => {
                    try {
                        await this.sessionStore.closeSession({ sessionId: sid, reason: "transport_closed" });
                    } catch (error) {
                        this.logger.error({
                            id: { __value: 10011 }, // LogId.streamableHttpTransportSessionCloseFailure
                            context: "streamableHttpTransport",
                            message: `Error closing session ${sid}: ${error instanceof Error ? error.message : String(error)}`,
                        });
                    }
                },
            });

            // HACK: When we're implicitly initializing the session, we want to configure the session id and _initialized flag on the transport
            // so that it believes it actually went through the initialization flow.
            if (isImplicitInitialization) {
                const internalTransport = transport["_webStandardTransport"] as {
                    _initialized: boolean;
                    sessionId: string;
                };
                internalTransport._initialized = true;
                internalTransport.sessionId = sessionId;
            }

            // Set session ID attribute on logger if available
            const serverWithLogger = server as { session?: { logger: ICompositeLogger } };
            serverWithLogger.session?.logger.setAttribute("sessionId", sessionId);

            const keepAliveLoop = this.startKeepAliveLoop(
                transport,
                server as TServer & { session?: { logger: ILogger } }
            );
            transport.onclose = (): void => {
                clearInterval(keepAliveLoop);

                const serverWithClose = server as { close(): Promise<void> };
                serverWithClose.close?.().catch((error: unknown) => {
                    this.logger.error({
                        id: { __value: 10012 }, // LogId.streamableHttpTransportCloseFailure
                        context: "streamableHttpTransport",
                        message: `Error closing server: ${error instanceof Error ? error.message : String(error)}`,
                    });
                });
            };

            const serverWithConnect = server as { connect(transport: StreamableHTTPServerTransport): Promise<void> };
            await serverWithConnect.connect(transport);

            await this.sessionStore.addSession({
                sessionId,
                transport,
                logger: serverWithLogger.session?.logger ?? this.logger,
            });
        })();

        this.pendingInitializations.set(sessionId, initPromise);
        try {
            await initPromise;
        } catch (error) {
            this.logger.error({
                id: { __value: 10013 }, // LogId.streamableHttpTransportRequestFailure
                context: "streamableHttpTransport",
                message: `Failed to initialize session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            });
            // Remove the partially initialized session on failure so that
            // subsequent requests don't see a broken session and can retry
            try {
                await this.sessionStore.closeSession({ sessionId, reason: "unknown" });
            } catch {
                // Session might not be in the store, that's fine
            }
            throw error;
        } finally {
            this.pendingInitializations.delete(sessionId);
        }
        return sessionId;
    }

    protected setupMiddlewares(): void {
        this.app.use(express.json({ limit: this.httpConfig.bodyLimit ?? 1024 * 1024 }));

        // Validate headers if configured
        const headers = this.httpConfig.headers;
        if (headers && Object.keys(headers).length > 0) {
            this.app.use((req, res, next) => {
                for (const [key, value] of Object.entries(headers)) {
                    const header = req.headers[key.toLowerCase()];
                    if (!header || header !== value) {
                        res.status(403).json({ error: `Invalid value for header "${key}"` });
                        return;
                    }
                }
                next();
            });
        }
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    protected override async setupRoutes(): Promise<void> {
        this.setupMiddlewares();

        const handleSessionRequest = async (req: express.Request, res: express.Response): Promise<void> => {
            const sessionId = req.headers["mcp-session-id"];
            if (!sessionId) {
                return this.reportSessionError(res, JSON_RPC_ERROR_CODE_SESSION_ID_REQUIRED);
            }

            if (typeof sessionId !== "string") {
                return this.reportSessionError(res, JSON_RPC_ERROR_CODE_SESSION_ID_INVALID);
            }

            let transport = await this.sessionStore.getSession(sessionId);
            if (!transport) {
                if (!this.sessionConfig.externallyManagedSessions) {
                    this.logger.debug({
                        id: { __value: 10010 }, // LogId.streamableHttpTransportSessionNotFound
                        context: "streamableHttpTransport",
                        message: `Session with ID ${sessionId} not found`,
                    });
                    return this.reportSessionError(res, JSON_RPC_ERROR_CODE_SESSION_NOT_FOUND);
                }

                const resolvedSessionId = await this.ensureSessionInitialized({
                    req,
                    sessionId,
                    isImplicitInitialization: true,
                });
                transport = await this.sessionStore.getSession(resolvedSessionId);
                if (!transport) {
                    return this.reportSessionError(res, JSON_RPC_ERROR_CODE_SESSION_NOT_FOUND);
                }
            }

            await transport.handleRequest(req, res, req.body);
        };

        this.app.post(
            "/mcp",
            this.withErrorHandling(async (req: express.Request, res: express.Response) => {
                const sessionId = req.headers["mcp-session-id"];
                if (sessionId && typeof sessionId !== "string") {
                    return this.reportSessionError(res, JSON_RPC_ERROR_CODE_SESSION_ID_INVALID);
                }

                if (isInitializeRequest(req.body)) {
                    if (sessionId && !this.sessionConfig.externallyManagedSessions) {
                        this.logger.debug({
                            id: { __value: 10014 }, // LogId.streamableHttpTransportDisallowedExternalSessionError
                            context: "streamableHttpTransport",
                            message: `Client provided session ID ${sessionId}, but externallyManagedSessions is disabled`,
                        });
                        return this.reportSessionError(res, JSON_RPC_ERROR_CODE_DISALLOWED_EXTERNAL_SESSION);
                    }

                    const resolvedSessionId = await this.ensureSessionInitialized({
                        req,
                        sessionId,
                        isImplicitInitialization: false,
                    });
                    const transport = await this.sessionStore.getSession(resolvedSessionId);
                    if (!transport) {
                        return this.reportSessionError(res, JSON_RPC_ERROR_CODE_SESSION_NOT_FOUND);
                    }
                    await transport.handleRequest(req, res, req.body);
                    return;
                }

                if (sessionId) {
                    return await handleSessionRequest(req, res);
                }

                return this.reportSessionError(res, JSON_RPC_ERROR_CODE_INVALID_REQUEST);
            })
        );

        this.app.get(
            "/mcp",
            this.withErrorHandling(async (req, res): Promise<void> => {
                if (this.httpConfig.responseType === "sse") {
                    await handleSessionRequest(req, res);
                } else {
                    // Don't allow SSE upgrades if the response type is JSON
                    res.status(405).set("Allow", ["POST", "DELETE"]).send("Method Not Allowed");
                }
            })
        );

        this.app.delete("/mcp", this.withErrorHandling(handleSessionRequest));
    }

    private withErrorHandling(
        fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
    ) {
        return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
            fn(req, res, next).catch((error) => {
                this.logger.error({
                    id: { __value: 10013 }, // LogId.streamableHttpTransportRequestFailure
                    context: "streamableHttpTransport",
                    message: `Error handling request: ${error instanceof Error ? error.message : String(error)}`,
                });

                const message = `failed to handle request`;

                res.status(400).json({
                    jsonrpc: "2.0",
                    error: {
                        code: JSON_RPC_ERROR_CODE_PROCESSING_REQUEST_FAILED,
                        message,
                    },
                });
            });
        };
    }
}

/**
 * Creates a default MCPHttpServer instance from the provided constructor arguments.
 */
export const createDefaultMcpHttpServer = <
    TServer = unknown,
    TContext = unknown,
    TMetrics extends MetricDefinitions = MetricDefinitions,
>(
    args: MCPHttpServerConstructorArgs<TServer, TContext, TMetrics>
): MCPHttpServer<TServer, TContext, TMetrics> => new MCPHttpServer<TServer, TContext, TMetrics>(args);
