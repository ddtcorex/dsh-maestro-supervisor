export interface LaunchTarget {
    port: number;
    token: string;
}
/**
 * Parse the newest `dsh web: http://127.0.0.1:<port>/?token=<tok>` boot line
 * from the dsh web log. The launch token and the raw-webserver port (which is
 * 3082 on the local-pin-gate topology, 3080 before it) both live there.
 */
export declare function parseLaunchTarget(logContent: string): LaunchTarget | undefined;
export interface MintCookieOpts {
    /** Path to the dsh web log holding the launch line; defaults to `~/.dsh/dsh-web.log`. */
    logPath?: string;
    /** Raw-webserver base URL; overrides the log-derived port (tests). */
    upstreamUrl?: string;
    /** Injectable file reader (tests). */
    readFileImpl?: (path: string) => Promise<string>;
}
export declare function defaultLogPath(): string;
/**
 * Mint the `dsh-auth-*` session cookie by trading the boot launch token on the
 * raw webserver (index fence: `?token=` -> 303 + Set-Cookie). Returns the
 * `name=value` cookie pair, or undefined when the log is unreadable, no boot
 * line exists, or the exchange does not mint a cookie (upstream 401 etc.).
 */
export declare function mintDshSessionCookie(fetchFn: (url: string, init: RequestInit) => Promise<Response>, opts?: MintCookieOpts): Promise<string | undefined>;
