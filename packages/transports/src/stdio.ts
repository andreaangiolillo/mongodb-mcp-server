import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { MetricDefinitions } from "@mongodb-js/mcp-types";
import { LogId } from "@mongodb-js/mcp-core";
import { TransportRunnerBase } from "./base.js";
import type {
    StdioRunnerOptions,
    CustomizableServerOptions,
    CustomizableSessionOptions,
    ServerFactory,
} from "./types.js";

/**
 * Transport runner for stdio (standard input/output) transport.
 * This is the default transport for MCP servers.
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

    constructor({
        serverFactory,
        loggers,
        metrics,
    }: StdioRunnerOptions<TMetrics> & { serverFactory: ServerFactory<TServer, TContext, TMetrics> }) {
        super({ serverFactory, loggers, metrics });
    }

    async start({
        serverOptions,
    }: {
        serverOptions?: CustomizableServerOptions<TContext>;
        sessionOptions?: CustomizableSessionOptions;
    } = {}): Promise<void> {
        try {
            this.server = await this.createServer({ serverOptions });
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

    async closeTransport(): Promise<void> {
        await this.server?.close();
    }
}
