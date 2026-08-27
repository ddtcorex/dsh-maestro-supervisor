export interface NotifierOpts {
  send?: (msg: string) => Promise<void>
}

export async function notify(msg: string, opts: NotifierOpts = {}): Promise<void> {
  const send = opts.send ?? defaultSend
  try {
    await send(msg)
  } catch {
    // never block caller
  }
}

async function defaultSend(msg: string): Promise<void> {
  // Try dsh-maestro-notifier tool if available, fallback to no-op
  // In real daemon, this will be wired to notifier's Telegram tool
  // For now, just log
  console.log(`[supervisor notify] ${msg}`)
}

export async function notifyCrash(reportPath: string, error: string, opts: NotifierOpts = {}): Promise<void> {
  await notify(`CRASH detected → rollback (report: ${reportPath}, error: ${error})`, opts)
}

export async function notifyDegraded(id: string, error: string, opts: NotifierOpts = {}): Promise<void> {
  await notify(`DEGRADED: ${id} failed — ${error}`, opts)
}

export async function notifyFixed(branch: string, sessions: string[], opts: NotifierOpts = {}): Promise<void> {
  await notify(`FIXED: ${branch}, sessions resumed: [${sessions.join(', ')}]`, opts)
}
