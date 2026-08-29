import { checkPlannedRestart } from './restart-guards.js';
export async function notifyAutoRestart(reason, opts = {}) {
    if (checkPlannedRestart())
        return;
    const httpCode = opts.httpCode ?? 'n/a';
    const lkgId = opts.lkgId ?? opts.lkg ?? 'n/a';
    const reportPath = opts.reportPath ?? opts.report ?? 'n/a';
    const msg = `🔄 dsh web auto-restart — ${reason} — ${new Date().toISOString()} — up:${httpCode} — LKG:${lkgId} — report:${reportPath}`;
    await notify(msg, opts);
}
export async function notify(msg, opts = {}) {
    const send = opts.send ?? defaultSend;
    try {
        await send(msg);
    }
    catch {
        // never block caller — rollback/report must not fail due to notifier
    }
}
async function defaultSend(msg) {
    // 1) Try hard dependency: @ddtcorex/dsh-maestro-notifier if installed (workspace:^)
    try {
        // dynamic import so daemon still runs when notifier is not installed (loose mode)
        // @ts-ignore — optional hard dep, may not be installed
        const mod = await import('@ddtcorex/dsh-maestro-notifier').catch(() => null);
        if (mod?.sendTelegram || mod?.notify) {
            const fn = mod.sendTelegram ?? mod.notify;
            await fn(msg);
            return;
        }
    }
    catch {
        // ignore and fall through
    }
    // 2) Try env Telegram token (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
        try {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' }),
            });
            return;
        }
        catch {
            // fall through to log
        }
    }
    // 3) Fallback — log only, never throw
    console.log(`[supervisor notify] ${msg}`);
}
export async function notifyCrash(reportPath, error, opts = {}) {
    await notify(`CRASH detected → rollback (report: ${reportPath}, error: ${error})`, opts);
}
export async function notifyDegraded(id, error, opts = {}) {
    await notify(`DEGRADED: ${id} failed — ${error}`, opts);
}
export async function notifyFixed(branch, sessions, opts = {}) {
    await notify(`FIXED: ${branch}, sessions resumed: [${sessions.join(', ')}]`, opts);
}
