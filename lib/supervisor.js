export class Supervisor {
    deps;
    lastRollback = 0;
    rollingBack = false;
    lastLKGWrite = 0;
    timer = null;
    constructor(deps) {
        this.deps = deps;
    }
    async tick() {
        const health = await this.deps.pollHealth();
        if (health.up) {
            // Throttle LKG writes to at most once per 5 minutes
            const now = this.deps.getTime ? this.deps.getTime() : Date.now();
            if (now - this.lastLKGWrite > 5 * 60 * 1000) {
                try {
                    await this.deps.writeLKG();
                    this.lastLKGWrite = now;
                }
                catch {
                    // ignore snapshot errors
                }
            }
            return;
        }
        // Down — check debounce and rolling state
        if (this.rollingBack)
            return;
        const now = this.deps.getTime ? this.deps.getTime() : Date.now();
        const debounceMs = this.deps.debounceMs ?? 60000;
        if (now - this.lastRollback < debounceMs)
            return;
        this.rollingBack = true;
        this.lastRollback = now;
        try {
            const failed = await this.deps.writeFailed().catch(() => ({ ts: new Date().toISOString().replace(/[:.]/g, '-'), manifest: null }));
            const ts = failed?.ts ?? new Date().toISOString().replace(/[:.]/g, '-');
            const reportPath = await this.deps.writeReport({ ts, health, action: `rollback — ${health.error ?? 'down'}` }).catch(() => '');
            await this.deps.rollback();
            await this.deps.notify(`CRASH detected → rollback (report: ${reportPath}, error: ${health.error ?? 'down'})`).catch(() => { });
        }
        finally {
            this.rollingBack = false;
        }
    }
    start() {
        if (this.timer)
            return;
        const intervalMs = this.deps.intervalMs ?? 3000;
        this.timer = setInterval(() => { this.tick().catch(() => { }); }, intervalMs);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
