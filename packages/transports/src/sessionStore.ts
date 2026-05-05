import type {
    ILogger,
    IMetrics,
    CloseableTransport,
    SessionCloseReason,
    MetricDefinitions,
} from "@mongodb-js/mcp-types";
import type { ISessionStore, SessionStoreConstructorArgs, CreateSessionStoreFn } from "./types.js";

export type { ISessionStore, SessionStoreConstructorArgs, CreateSessionStoreFn };

/**
 * A managed timeout that can be restarted or canceled.
 */
interface ManagedTimeout {
    restart(): void;
    cancel(): void;
}

function setManagedTimeout(callback: () => void | Promise<void>, delay: number): ManagedTimeout {
    let timeoutId: NodeJS.Timeout | undefined;

    function start(): void {
        timeoutId = setTimeout(() => {
            void callback();
        }, delay);
    }

    function cancel(): void {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
        }
    }

    start();

    return {
        restart: (): void => {
            cancel();
            start();
        },
        cancel,
    };
}

/**
 * Default in-memory session store implementation.
 */
export class SessionStore<T extends CloseableTransport = CloseableTransport> implements ISessionStore<T> {
    private sessions: {
        [sessionId: string]: {
            logger: ILogger;
            transport: T;
            abortTimeout: ManagedTimeout;
            notificationTimeout: ManagedTimeout;
        };
    } = {};

    private readonly idleTimeoutMS: number;
    private readonly notificationTimeoutMS: number;
    private readonly logger: ILogger;
    private readonly metrics: IMetrics<MetricDefinitions>;

    constructor(params: SessionStoreConstructorArgs<MetricDefinitions>) {
        const { options, logger, metrics } = params;
        this.idleTimeoutMS = options.idleTimeoutMS;
        this.notificationTimeoutMS = options.notificationTimeoutMS;
        this.logger = logger;
        this.metrics = metrics;

        if (this.idleTimeoutMS <= 0) {
            throw new Error("idleTimeoutMS must be greater than 0");
        }
        if (this.notificationTimeoutMS <= 0) {
            throw new Error("notificationTimeoutMS must be greater than 0");
        }
        if (this.idleTimeoutMS <= this.notificationTimeoutMS) {
            throw new Error("idleTimeoutMS must be greater than notificationTimeoutMS");
        }
    }

    async getSession(sessionId: string): Promise<T | undefined> {
        this.resetTimeout(sessionId);
        return Promise.resolve(this.sessions[sessionId]?.transport);
    }

    private resetTimeout(sessionId: string): void {
        const session = this.sessions[sessionId];
        if (!session) {
            return;
        }
        session.abortTimeout.restart();
        session.notificationTimeout.restart();
    }

    private sendNotification(sessionId: string): void {
        const session = this.sessions[sessionId];
        if (!session) {
            this.logger.warning({
                id: { __value: 10004 }, // LogId.streamableHttpTransportSessionCloseNotificationFailure
                context: "sessionStore",
                message: `session ${sessionId} not found, no notification delivered`,
            });
            return;
        }
        session.logger.info({
            id: { __value: 10005 }, // LogId.streamableHttpTransportSessionCloseNotification
            context: "sessionStore",
            message: "Session is about to be closed due to inactivity",
        });
    }

    async addSession(params: { sessionId: string; transport: T; logger: ILogger }): Promise<void> {
        const { sessionId, transport, logger } = params;
        const session = this.sessions[sessionId];
        if (session) {
            throw new Error(`Session ${sessionId} already exists`);
        }
        const abortTimeout = setManagedTimeout(async () => {
            if (this.sessions[sessionId]) {
                this.sessions[sessionId].logger.info({
                    id: { __value: 10005 }, // LogId.streamableHttpTransportSessionCloseNotification
                    context: "sessionStore",
                    message: "Session closed due to inactivity",
                });
                await this.closeSession({ sessionId, reason: "idle_timeout" });
            }
        }, this.idleTimeoutMS);
        const notificationTimeout = setManagedTimeout(
            () => this.sendNotification(sessionId),
            this.notificationTimeoutMS
        );
        this.sessions[sessionId] = {
            transport,
            abortTimeout,
            notificationTimeout,
            logger,
        };
        // Track session created metric if available
        const sessionCreatedMetric = this.metrics.get("sessionCreated");
        if (sessionCreatedMetric && typeof sessionCreatedMetric === "object" && "inc" in sessionCreatedMetric) {
            (sessionCreatedMetric as { inc(): void }).inc();
        }
        return Promise.resolve();
    }

    async closeSession({
        sessionId,
        reason = "unknown",
    }: {
        sessionId: string;
        reason?: SessionCloseReason;
    }): Promise<void> {
        const session = this.sessions[sessionId];
        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }

        // Remove from map before closing transport so that a re-entrant
        // onsessionclosed callback (fired by transport.close()) sees the
        // session as already gone and doesn't double-count metrics.
        delete this.sessions[sessionId];

        session.abortTimeout.cancel();
        session.notificationTimeout.cancel();

        if (reason !== "transport_closed") {
            // Only close the transport when the server initiates the close.
            try {
                await session.transport.close();
            } catch (error) {
                this.logger.error({
                    id: { __value: 10006 }, // LogId.streamableHttpTransportSessionCloseFailure
                    context: "streamableHttpTransport",
                    message: `Error closing transport ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
        }

        // Track session closed metric if available
        const sessionClosedMetric = this.metrics.get("sessionClosed");
        if (sessionClosedMetric && typeof sessionClosedMetric === "object" && "inc" in sessionClosedMetric) {
            (sessionClosedMetric as { inc(labels?: Record<string, string>): void }).inc({ reason });
        }
    }

    async closeAllSessions(): Promise<void> {
        await Promise.all(
            Object.keys(this.sessions).map((sessionId) => this.closeSession({ sessionId, reason: "server_stop" }))
        );
    }
}

/**
 * Creates a default SessionStore instance from the provided constructor arguments.
 */
export function createDefaultSessionStore<
    TTransport extends CloseableTransport = CloseableTransport,
    TMetrics extends MetricDefinitions = MetricDefinitions,
>(params: SessionStoreConstructorArgs<TMetrics>): SessionStore<TTransport> {
    return new SessionStore<TTransport>(params as SessionStoreConstructorArgs<MetricDefinitions>);
}
