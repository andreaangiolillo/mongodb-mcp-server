import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { MetricDefinitions } from "@mongodb-js/mcp-types";
import { LogId } from "@mongodb-js/mcp-core";
import { TransportRunnerBase } from "./base.js";
import type { StdioRunnerOptions, CustomizableServerOptions, CustomizableSessionOptions } from "./types.js";

export type CreateServerFn<TServer, TContext = unknown> = (options: {
    serverOptions?: CustomizableServerOptions<TContext>;
    sessionOptions?: CustomizableSessionOptions;
}) => Promise<TServer>;

/**
 * Extended options for StdioRunner that include a server factory function.
 */
export type StdioRunnerOptionsWithFactory<
    TServer = unknown,
    TContext = unknown,
    TMetrics extends MetricDefinitions = MetricDefinitions,
> = StdioRunnerOptions<TMetrics> & {
    /** Factory function to create the server instance */
    createServer: CreateServerFn<TServer, TContext>;
};

/**
 * Transport runner for stdio (standard input/output) transport.
 * This is the default transport for MCP servers.
 *
 * You can either:
 * 1. Pass a `createServer` factory function to the constructor
 * 2. Extend this class and override the `createServer()` method
 *
 * @example Using a factory function
 * ```typescript
 * const runner = new StdioRunner({
 *   loggers,
 *   createServer: async ({ serverOptions, sessionOptions }) => {
 *     return new MyServer({ ... });
 *   }
 * });
 * ```
 *
 * @example Using subclassing
 * ```typescript
 * class MyStdioRunner extends StdioRunner {
 *   protected override async createServer({ serverOptions, sessionOptions }) {
 *     return new MyServer({ ... });
 *   }
 * }
 * ```
 */
export class StdioRunner<
    TServer extends {
        connect(transport: StdioServerTransport): Promise<void>;
        close(): Promise<void>;
    } = {
        connect(transport: StdioServerTransport): Promise<void>;
        close(): Promise<void>;
    },
    TContext = unknown,
    TMetrics extends MetricDefinitions = MetricDefinitions,
> extends TransportRunnerBase<TServer, TContext, TMetrics> {
    private server: TServer | undefined;
    private createServerFn?: CreateServerFn<TServer, TContext>;

    constructor({ loggers, metrics, createServer }: StdioRunnerOptionsWithFactory<TServer, TContext, TMetrics>) {
        super({ loggers, metrics });
        this.createServerFn = createServer;
    }

    async start({
        serverOptions,
        sessionOptions,
    }: {
        serverOptions?: CustomizableServerOptions<TContext>;
        sessionOptions?: CustomizableSessionOptions;
    } = {}): Promise<void> {
        try {
            this.server = await this.createServer({ serverOptions, sessionOptions });
            const transport = new StdioServerTransport();
            await this.server.connect(transport);
        } catch (error: unknown) {
            this.logger.emergency({
                id: LogId.serverStartFailure,
                context: "server",
                message: `Fatal error running server: ${error as string}`,
            });
            process.exit(1);
        }
    }

    /**
     * Stops the stdio transport runner.
     * This closes the server connection.
     */
    async stop(): Promise<void> {
        await this.server?.close();
    }

    /**
     * Creates the server instance. Override this method in subclasses
     * to customize server creation, or provide a `createServer` function
     * to the constructor.
     */
    protected createServer({
        serverOptions,
        sessionOptions,
    }: {
        serverOptions?: CustomizableServerOptions<TContext>;
        sessionOptions?: CustomizableSessionOptions;
    }): Promise<TServer> {
        if (this.createServerFn) {
            return this.createServerFn({ serverOptions, sessionOptions });
        }
        throw new Error("StdioRunner: either provide createServer in constructor or override createServer() method");
    }
}
