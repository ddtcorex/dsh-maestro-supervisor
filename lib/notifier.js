export async function notify(msg, opts = {}) {
    const send = opts.send ?? defaultSend;
    try {
        await send(msg);
    }
    catch {
        // never block caller
    }
}
async function defaultSend(msg) {
    // Try dsh-maestro-notifier tool if available, fallback to no-op
    // In real daemon, this will be wired to notifier's Telegram tool
    // For now, just log
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
