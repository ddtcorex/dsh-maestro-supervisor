import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
/**
 * Parse the newest `dsh web: http://127.0.0.1:<port>/?token=<tok>` boot line
 * from the dsh web log. The launch token and the raw-webserver port (which is
 * 3082 on the local-pin-gate topology, 3080 before it) both live there.
 */
export function parseLaunchTarget(logContent) {
    const matches = [...logContent.matchAll(/dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9._-]+)/g)];
    const last = matches.at(-1);
    if (last === undefined)
        return undefined;
    return { port: Number(last[1]), token: last[2] };
}
export function defaultLogPath() {
    return join(homedir(), '.dsh', 'dsh-web.log');
}
/**
 * Mint the `dsh-auth-*` session cookie by trading the boot launch token on the
 * raw webserver (index fence: `?token=` -> 303 + Set-Cookie). Returns the
 * `name=value` cookie pair, or undefined when the log is unreadable, no boot
 * line exists, or the exchange does not mint a cookie (upstream 401 etc.).
 */
export async function mintDshSessionCookie(fetchFn, opts = {}) {
    const read = opts.readFileImpl ?? ((p) => readFile(p, 'utf8'));
    let target;
    try {
        target = parseLaunchTarget(await read(opts.logPath ?? defaultLogPath()));
    }
    catch {
        target = undefined;
    }
    if (target === undefined)
        return undefined;
    const upstream = opts.upstreamUrl ?? `http://127.0.0.1:${target.port}`;
    const response = await fetchFn(`${upstream}/?token=${encodeURIComponent(target.token)}`, {
        redirect: 'manual',
        headers: { accept: 'text/html' },
    });
    if (response.status !== 303 && response.status !== 302)
        return undefined;
    const pair = (response.headers.get('set-cookie') ?? '').split(';')[0]?.trim() ?? '';
    return pair.startsWith('dsh-auth-') ? pair : undefined;
}
