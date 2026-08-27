export interface NotifierOpts {
  send?: (msg: string) => Promise<void>
}

export async function notify(msg: string, opts: NotifierOpts = {}): Promise<void> {
  const send = opts.send ?? defaultSend
  try {
    await send(msg)
  } catch {
    // never block caller — rollback/report must not fail due to notifier
  }
}

async function defaultSend(msg: string): Promise<void> {
  // 1) Try hard dependency: @ddtcorex/dsh-maestro-notifier if installed (workspace:^)
  try {
    // dynamic import so daemon still runs when notifier is not installed (loose mode)
    // @ts-ignore — optional hard dep, may not be installed
    const mod: any = await import('@ddtcorex/dsh-maestro-notifier' as any).catch(() => null)
    if (mod?.sendTelegram || mod?.notify) {
      const fn = mod.sendTelegram ?? mod.notify
      await fn(msg)
      return
    }
  } catch {
    // ignore and fall through
  }
  // 2) Try env Telegram token (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (token && chatId) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' }),
      })
      return
    } catch {
      // fall through to log
    }
  }
  // 3) Fallback — log only, never throw
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
