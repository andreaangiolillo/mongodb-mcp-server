#!/usr/bin/env node
/* eslint-disable no-console */

function enableFipsIfRequested(): void {
    let fipsError: Error | undefined;
    const tlsFIPSMode = process.argv.includes("--tlsFIPSMode");

    if (tlsFIPSMode) {
        try {
            // eslint-disable-next-line
            require("crypto").setFips(1);
        } catch (err: unknown) {
            fipsError ??= err as Error;
        }
    }

    if (tlsFIPSMode) {
        if (!fipsError && !crypto.getFips()) {
            fipsError = new Error("FIPS mode not enabled despite requested due to unknown error.");
        }
    }

    if (fipsError) {
        if (process.config.variables.node_shared_openssl) {
            console.error(
                "Could not enable FIPS mode. Please ensure that your system OpenSSL installation supports FIPS."
            );
        } else {
            console.error("Could not enable FIPS mode. This installation does not appear to support FIPS.");
        }
        console.error("Error details:");
        console.error(fipsError);
        process.exit(1);
    }
}

enableFipsIfRequested();

import crypto from "crypto";
import { type LoggerBase, Keychain } from "@mongodb-js/mcp-core";
import { ConsoleLogger, DiskLogger, LogId } from "@mongodb-js/mcp-logging";
import { MongoLogManager } from "mongodb-log-writer";
import * as fs from "fs/promises";
import { parseUserConfig } from "./common/config/parseUserConfig.js";
import { type UserConfig } from "./common/config/userConfig.js";
import { packageInfo } from "./common/packageInfo.js";
import {
    StdioRunner,
    StreamableHttpRunner,
    DryRunModeRunner,
    MCPHttpServer,
    MonitoringServer,
    SessionStore,
} from "@mongodb-js/mcp-transports";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { systemCA } from "@mongodb-js/devtools-proxy-support";
import { runSetup } from "./setup/setupMcpServer.js";
import { PrometheusMetrics, createDefaultMetrics } from "@mongodb-js/mcp-metrics";
import type { IMetrics, MetricDefinitions } from "@mongodb-js/mcp-types";
import { Server } from "./server.js";
import { Session } from "./common/session.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SetupTelemetry } from "./setup/setupTelemetry.js";
import { Elicitation } from "./elicitation.js";
import { connectionErrorHandler } from "./common/connectionErrorHandler.js";
import { defaultCreateConnectionManager } from "./common/connectionManager.js";
import { createAtlasLocalClient } from "@mongodb-js/mcp-tools-atlas-local";
import { ApiClient } from "@mongodb-js/mcp-atlas-api-client";
import { ExportsManager } from "./common/exportsManager.js";
import { Keychain as CoreKeychain } from "@mongodb-js/mcp-core";

async function main(): Promise<void> {
    systemCA().catch(() => undefined); // load system CA asynchronously as in mongosh

    const args = process.argv.slice(2);
    const isSetupRequested = args[0] === "setup";
    if (isSetupRequested) {
        // remove the "setup" argument so it doesn't interfere with arg parsings
        args.shift();
    }

    const {
        error,
        warnings,
        parsed: config,
    } = parseUserConfig({
        args: process.argv.slice(2),
    });

    if (!config || (error && error.length)) {
        console.error(`${error}
- Refer to https://www.mongodb.com/docs/mcp-server/get-started/ for setting up the MCP Server.`);
        process.exit(1);
    }

    if (warnings && warnings.length) {
        console.warn(`${warnings.join("\n")}
- Refer to https://www.mongodb.com/docs/mcp-server/get-started/ for setting up the MCP Server.`);
    }

    if (config.help) {
        handleHelpRequest();
    }

    if (config.version) {
        handleVersionRequest();
    }

    if (isSetupRequested) {
        await runSetup(config);
    }

    if (config.dryRun) {
        await handleDryRunRequest(config);
    }

    const loggers = await createDefaultLoggers(config);
    const metrics = new PrometheusMetrics({ definitions: createDefaultMetrics() });

    let transportRunner: StdioRunner<Server> | StreamableHttpRunner<Server>;

    if (config.transport === "stdio") {
        transportRunner = new StdioRunner({
            loggers,
            metrics: metrics as IMetrics<MetricDefinitions>,
            createServer: async () => {
                return createServerForConfig(config, loggers[0], metrics);
            },
        });
    } else {
        const sessionStore = new SessionStore<StreamableHTTPServerTransport>({
            options: {
                idleTimeoutMS: 3600000,
                notificationTimeoutMS: 3000000,
            },
            logger: loggers[0]!,
            metrics: metrics as IMetrics<MetricDefinitions>,
        });

        const mcpHttpServer = new MCPHttpServer<Server>({
            httpConfig: {
                host: config.httpHost,
                port: config.httpPort,
                responseType: config.httpResponseType,
                headers: config.httpHeaders,
            },
            sessionConfig: {
                externallyManagedSessions: config.externallyManagedSessions,
                idleTimeoutMS: 3600000,
                notificationTimeoutMS: 3000000,
            },
            createServer: async () => {
                return createServerForConfig(config, loggers[0], metrics);
            },
            logger: loggers[0]!,
            metrics: metrics as IMetrics<MetricDefinitions>,
            sessionStore,
        });

        let monitoringServer: MonitoringServer | undefined;
        if (config.monitoringServerHost && config.monitoringServerPort) {
            monitoringServer = new MonitoringServer({
                config: {
                    host: config.monitoringServerHost,
                    port: config.monitoringServerPort,
                    features: config.monitoringServerFeatures,
                },
                logger: loggers[0]!,
                metrics: metrics as IMetrics<MetricDefinitions>,
            });
        }

        transportRunner = new StreamableHttpRunner({
            loggers,
            metrics: metrics as IMetrics<MetricDefinitions>,
            mcpHttpServer,
            monitoringServer,
            sessionStore,
        });
    }

    const shutdown = (): void => {
        transportRunner.logger.info({
            id: LogId.serverCloseRequested,
            context: "server",
            message: `Server close requested`,
        });

        transportRunner
            .close()
            .then(() => {
                transportRunner.logger.info({
                    id: LogId.serverClosed,
                    context: "server",
                    message: `Server closed`,
                });
                process.exit(0);
            })
            .catch((error: unknown) => {
                transportRunner.logger.error({
                    id: LogId.serverCloseFailure,
                    context: "server",
                    message: `Error closing server: ${error as string}`,
                });
                process.exit(1);
            });
    };

    process.on("SIGINT", shutdown);
    process.on("SIGABRT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("SIGQUIT", shutdown);

    try {
        await transportRunner.start();
    } catch (error: unknown) {
        transportRunner.logger.info({
            id: LogId.serverCloseRequested,
            context: "server",
            message: `Closing server due to error: ${error as string}`,
        });

        try {
            await transportRunner.close();
            transportRunner.logger.info({
                id: LogId.serverClosed,
                context: "server",
                message: "Server closed",
            });
        } catch (error: unknown) {
            transportRunner.logger.error({
                id: LogId.serverCloseFailure,
                context: "server",
                message: `Error closing server: ${error as string}`,
            });
        }
        throw error;
    }
}

main().catch((error: unknown) => {
    // At this point, we may be in a very broken state, so we can't rely on the logger
    // being functional. Instead, create a brand new ConsoleLogger and log the error
    // to the console.
    const logger = new ConsoleLogger({ keychain: Keychain.root });
    logger.emergency({
        id: LogId.serverStartFailure,
        context: "server",
        message: `Fatal error running server: ${error as string}`,
    });
    process.exit(1);
});

function handleHelpRequest(): never {
    console.log("For usage information refer to the README.md:");
    console.log("https://github.com/mongodb-js/mongodb-mcp-server?tab=readme-ov-file#quick-start");
    process.exit(0);
}

function handleVersionRequest(): never {
    console.log(packageInfo.version);
    process.exit(0);
}

export async function handleDryRunRequest(config: UserConfig): Promise<never> {
    try {
        const metrics = new PrometheusMetrics({ definitions: createDefaultMetrics() });
        const runner = new DryRunModeRunner({
            loggers: [],
            metrics: metrics as IMetrics<MetricDefinitions>,
            consoleLogger: {
                log(message: string): void {
                    console.log(message);
                },
                error(message: string): void {
                    console.error(message);
                },
            },
            createServer: async () => {
                return createServerForConfig(config, new ConsoleLogger({ keychain: Keychain.root }), metrics);
            },
        });
        await runner.start();
        await runner.close();
        process.exit(0);
    } catch (error) {
        console.error(`Fatal error running server in dry run mode: ${error as string}`);
        process.exit(1);
    }
}

async function createDefaultLoggers(config: UserConfig): Promise<LoggerBase[]> {
    const loggers: LoggerBase[] = [];

    if (config.loggers.includes("stderr")) {
        loggers.push(new ConsoleLogger({ keychain: Keychain.root }));
    }

    if (config.loggers.includes("disk")) {
        await fs.mkdir(config.logPath, { recursive: true });

        const manager = new MongoLogManager({
            directory: config.logPath,
            retentionDays: 30,
            onwarn: console.warn,
            onerror: console.error,
            gzip: false,
            retentionGB: 1,
        });

        await manager.cleanupOldLogFiles();
        const logWriter = await manager.createLogWriter();

        loggers.push(
            new DiskLogger({
                logWriter,
                keychain: Keychain.root,
            })
        );
    }

    return loggers;
}

async function createServerForConfig(
    config: UserConfig,
    logger: LoggerBase,
    metrics: PrometheusMetrics<ReturnType<typeof createDefaultMetrics>>
): Promise<Server> {
    const keychain = CoreKeychain.root;
    const exportsManager = new ExportsManager();
    const connectionManager = await defaultCreateConnectionManager();

    let apiClient: ApiClient | undefined;
    // Check if credentials are available
    if ((config as UserConfig & { publicKey?: string; privateKey?: string }).publicKey) {
        apiClient = new ApiClient({
            credentials: {
                publicKey: (config as UserConfig & { publicKey?: string; privateKey?: string }).publicKey!,
                privateKey: (config as UserConfig & { publicKey?: string; privateKey?: string }).privateKey!,
            },
        });
    }

    const atlasLocalClient = await createAtlasLocalClient({ logger, loader: async () => ({}) });

    const telemetry = new SetupTelemetry({
        userConfig: config,
        logger,
        keychain,
    });

    const elicitation = new Elicitation(logger);

    const session = new Session({
        userConfig: config,
        logger,
        exportsManager,
        connectionManager,
        keychain,
        apiClient: apiClient!, // session requires this but we may not have it
        connectionErrorHandler,
        atlasLocalClient,
    });

    const mcpServer = new McpServer({
        name: "mongodb-mcp-server",
        version: packageInfo.version,
    });

    const server = new Server({
        session,
        userConfig: config,
        mcpServer,
        telemetry,
        connectionErrorHandler,
        elicitation,
        metrics: metrics as PrometheusMetrics<ReturnType<typeof createDefaultMetrics>>,
    });

    return server;
}
