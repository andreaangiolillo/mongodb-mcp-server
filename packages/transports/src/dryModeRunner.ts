import type { MetricDefinitions } from "@mongodb-js/mcp-types";
import { TransportRunnerBase } from "./base.js";
import { InMemoryTransport } from "./inMemoryTransport.js";
import type { DryRunModeRunnerOptions, CustomizableServerOptions, CustomizableSessionOptions } from "./types.js";

export type CreateServerFn<TServer, TContext = unknown> = (options: {
    serverOptions?: CustomizableServerOptions<TContext>;
    sessionOptions?: CustomizableSessionOptions;
}) => Promise<TServer>;

/**
 * Extended options for DryRunModeRunner that include a server factory function.
 */
export type DryRunModeRunnerOptionsWithFactory<
    TServer = unknown,
    TContext = unknown,
    TMetrics extends MetricDefinitions = MetricDefinitions,
> = DryRunModeRunnerOptions<TMetrics> & {
    /** Factory function to create the server instance */
    createServer: CreateServerFn<TServer, TContext>;
};

/**
 * Test helpers interface for dry run mode.
 */
export type DryRunModeTestHelpers = {
    logger: {
        log(this: void, message: string): void;
        error(this: void, message: string): void;
    };
};

/**
 * Transport runner for dry-run mode.
 * Dumps configuration and enabled tools, then exits without starting the server.
 *
 * You can either:
 * 1. Pass a `createServer` factory function to the constructor
 * 2. Extend this class and override the `createServer()` method
 *
 * @example Using a factory function
 * ```typescript
 * const runner = new DryRunModeRunner({
 *   consoleLogger,
 *   createServer: async ({ serverOptions, sessionOptions }) => {
 *     return new MyServer({ ... });
 *   }
 * });
 * ```
 *
 * @example Using subclassing
 * ```typescript
 * class MyDryRunRunner extends DryRunModeRunner {
 *   protected override async createServer({ serverOptions, sessionOptions }) {
 *     return new MyServer({ ... });
 *   }
 * }
 * ```
 */
export class DryRunModeRunner<
    TServer extends {
        tools: { name: string; category: string; isEnabled(): boolean }[];
        connect(transport: InMemoryTransport): Promise<void>;
        close(): Promise<void>;
    } = {
        tools: { name: string; category: string; isEnabled(): boolean }[];
        connect(transport: InMemoryTransport): Promise<void>;
        close(): Promise<void>;
    },
    TContext = unknown,
    TMetrics extends MetricDefinitions = MetricDefinitions,
> extends TransportRunnerBase<TServer, TContext, TMetrics> {
    private server: TServer | undefined;
    private consoleLogger: DryRunModeTestHelpers["logger"];
    private createServerFn?: CreateServerFn<TServer, TContext>;

    constructor({
        loggers,
        metrics,
        consoleLogger,
        createServer,
    }: DryRunModeRunnerOptionsWithFactory<TServer, TContext, TMetrics>) {
        super({ loggers, metrics });
        this.consoleLogger = consoleLogger;
        this.createServerFn = createServer;
    }

    override async start({
        serverOptions,
        sessionOptions,
    }: {
        serverOptions?: CustomizableServerOptions<TContext>;
        sessionOptions?: CustomizableSessionOptions;
    } = {}): Promise<void> {
        this.server = await this.createServer({ serverOptions, sessionOptions });
        const transport = new InMemoryTransport();

        await this.server.connect(transport);
        this.dumpTools();
    }

    /**
     * Stops the dry run mode runner.
     * This closes the server connection.
     */
    override async stop(): Promise<void> {
        await this.server?.close();
    }

    private dumpTools(): void {
        const tools =
            this.server?.tools
                .filter((tool) => tool.isEnabled())
                .map((tool) => ({
                    name: tool.name,
                    category: tool.category,
                })) ?? [];
        this.consoleLogger.log("Enabled tools:");
        this.consoleLogger.log(JSON.stringify(tools, null, 2));
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
        throw new Error(
            "DryRunModeRunner: either provide createServer in constructor or override createServer() method"
        );
    }
}
