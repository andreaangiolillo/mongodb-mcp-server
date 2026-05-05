import { CompositeLogger, type LoggerBase } from "@mongodb-js/mcp-core";
import type { IMetrics, MetricDefinitions } from "@mongodb-js/mcp-types";
import type {
    ServerFactory,
    ServerOptions,
    TransportRunnerBaseOptions,
    CustomizableServerOptions,
    CustomizableSessionOptions,
} from "./types.js";

/**
 * Base class for all transport runners.
 * Provides common functionality and uses ServerFactory for decoupled server creation.
 */
export abstract class TransportRunnerBase<
    TServer = unknown,
    TContext = unknown,
    TMetrics extends MetricDefinitions = MetricDefinitions,
> {
    public logger: CompositeLogger;
    public metrics: IMetrics<TMetrics>;

    /** Server factory for creating server instances */
    protected readonly serverFactory: ServerFactory<TServer, TContext, TMetrics>;

    protected constructor({
        serverFactory,
        loggers,
        metrics,
    }: TransportRunnerBaseOptions<TMetrics> & { serverFactory: ServerFactory<TServer, TContext, TMetrics> }) {
        this.serverFactory = serverFactory;
        this.metrics = metrics ?? ({ getMetrics: () => Promise.resolve("") } as unknown as IMetrics<TMetrics>);

        // Initialize logger
        const baseLoggers = (loggers as LoggerBase[] | undefined) ?? [];
        this.logger = new CompositeLogger({ loggers: baseLoggers });
    }

    /**
     * Creates a new MCP server instance with the provided configuration.
     * Uses the injected ServerFactory.
     */
    protected async createServer({
        serverOptions,
    }: {
        serverOptions?: CustomizableServerOptions<TContext>;
    } = {}): Promise<TServer> {
        // Server factory handles the actual server creation
        // We pass the merged options to the factory
        return this.serverFactory.createServer(serverOptions as ServerOptions<TContext, TMetrics>);
    }

    /**
     * Starts the transport runner.
     */
    abstract start({
        serverOptions,
        sessionOptions,
    }: {
        serverOptions?: CustomizableServerOptions<TContext>;
        sessionOptions?: CustomizableSessionOptions;
    }): Promise<void>;

    /**
     * Closes the transport.
     */
    abstract closeTransport(): Promise<void>;

    /**
     * Closes the transport runner and cleans up resources.
     */
    async close(): Promise<void> {
        try {
            await this.closeTransport();
        } finally {
            await this.logger.flush();
        }
    }
}
