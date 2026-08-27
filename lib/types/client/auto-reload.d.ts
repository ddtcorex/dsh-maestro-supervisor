/**
 * dsh-maestro-supervisor — client auto-reload for DSH Web after restart.
 * Hybrid: polls `HEAD /` when the server is down (offline/WebSocket close)
 * and reloads as soon as it is back. The host also pushes a reload via
 * `POST /dsh-maestro-supervisor-reload` (loopback) when it recovers.
 */
export declare function apply(ctx: any): void;
//# sourceMappingURL=auto-reload.d.ts.map