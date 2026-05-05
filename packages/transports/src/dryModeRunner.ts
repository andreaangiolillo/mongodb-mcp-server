import type { MetricDefinitions } from "@mongodb-js/mcp-types";
import { TransportRunnerBase } from "./base.js";
import { InMemoryTransport } from "./inMemoryTransport.js";
import type {
    DryRunModeRunnerOptions,
    CustomizableServerOptions,
    CustomizableSessionOptions,
    ServerFactory,
} from "./types.js";

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

    constructor({
        serverFactory,
        consoleLogger,
        loggers,
        metrics,
    }: DryRunModeRunnerOptions<TMetrics> & { serverFactory: ServerFactory<TServer, TContext, TMetrics> }) {
        super({ serverFactory, loggers, metrics });
        this.consoleLogger = consoleLogger;
    }

    override async start({
        serverOptions,
    }: {
        serverOptions?: CustomizableServerOptions<TContext>;
        sessionOptions?: CustomizableSessionOptions;
    } = {}): Promise<void> {
        this.server = await this.createServer({ serverOptions });
        const transport = new InMemoryTransport();

        await this.server.connect(transport);
        this.dumpTools();
    }

    override async closeTransport(): Promise<void> {
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
}
