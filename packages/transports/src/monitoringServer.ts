import type express from "express";
import type { ILogger, IMetrics, MetricDefinitions } from "@mongodb-js/mcp-types";
import { ExpressBasedHttpServer } from "./expressBasedHttpServer.js";
import type { MonitoringServerFeature } from "./types.js";

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
 * When provided, the runner will use this function instead of the default MonitoringServer constructor.
 */
export type CreateMonitoringServerFn<TMetrics extends MetricDefinitions = MetricDefinitions> = (
    args: MonitoringServerConstructorArgs<TMetrics>
) => MonitoringServer<TMetrics> | undefined;

/**
 * HTTP server that provides monitoring endpoints like health checks and metrics.
 */
export class MonitoringServer<TMetrics extends MetricDefinitions = MetricDefinitions> extends ExpressBasedHttpServer {
    private readonly features: MonitoringServerFeature[];
    private readonly metrics: IMetrics<TMetrics>;

    constructor({ host, port, features, logger, metrics }: MonitoringServerConstructorArgs<TMetrics>) {
        super({ port, hostname: host, logger, logContext: "monitoringServer" });
        this.features = features;
        this.metrics = metrics;
    }

    protected override setupRoutes(): Promise<void> {
        if (this.features.includes("health-check")) {
            this.app.get("/health", (_req: express.Request, res: express.Response) => {
                res.json({ status: "ok" });
            });
        }

        if (this.features.includes("metrics")) {
            this.app.get("/metrics", async (_req: express.Request, res: express.Response) => {
                try {
                    const output = await this.metrics.getMetrics();
                    res.set("Content-Type", "text/plain");
                    res.send(output);
                } catch (error: unknown) {
                    this.logger.error({
                        id: { __value: 10007 }, // LogId.monitoringServerMetricsFailure
                        context: "monitoringServer",
                        message: `Failed to retrieve metrics: ${String(error)}`,
                    });
                    res.status(500).json({ error: "Failed to retrieve metrics" });
                }
            });
        }

        return Promise.resolve();
    }
}

/**
 * Creates a default MonitoringServer instance from the provided constructor arguments.
 */
export const createDefaultMonitoringServer: <TMetrics extends MetricDefinitions = MetricDefinitions>(
    args: MonitoringServerConstructorArgs<TMetrics>
) => MonitoringServer<TMetrics> = <TMetrics extends MetricDefinitions = MetricDefinitions>(
    args: MonitoringServerConstructorArgs<TMetrics>
) => new MonitoringServer<TMetrics>(args);
