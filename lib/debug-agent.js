let lastRun = 0;
let attempts = 0;
const MAX_ATTEMPTS = 3;
export async function runDebugAgent(opts) {
    const now = Date.now();
    const cooldownMs = opts.cooldownMs ?? 10 * 60 * 1000;
    if (now - lastRun < cooldownMs) {
        return { fixed: false, reason: 'cooldown' };
    }
    if (attempts >= MAX_ATTEMPTS) {
        return { fixed: false, reason: 'max attempts' };
    }
    lastRun = now;
    attempts++;
    // Stub: Phase 3 full LLM wiring will use systematic-debugging preset
    // For now just log and return not fixed — supervisor will still resume sessions
    // Real implementation: spawn subagent via @ddtcorex/dsh-maestro-notifier or openai
    return { fixed: false, reason: `stub — would debug ${opts.reportPath} (attempt ${attempts})` };
}
export function _resetDebugAgentForTest() {
    lastRun = 0;
    attempts = 0;
}
