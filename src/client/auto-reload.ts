/**
 * dsh-maestro-supervisor — client auto-reload for DSH Web after restart.
 * Hybrid: polls `HEAD /` when the server is down (offline/WebSocket close)
 * and reloads as soon as it is back. The host also pushes a reload via
 * `POST /dsh-maestro-supervisor-reload` (loopback) when it recovers.
 */

export function apply(ctx: any): void {
  try {
    ctx.effect(() => {
      let timer: ReturnType<typeof setInterval> | null = null
      let reloading = false

      const checkAndReload = async () => {
        if (reloading) return
        try {
          const res = await fetch('/', { method: 'HEAD', cache: 'no-store' })
          if (res.ok) {
            reloading = true
            if (timer) { clearInterval(timer); timer = null }
            window.location.reload()
          }
        } catch {
          // still down — keep polling
        }
      }

      const startPolling = () => {
        if (timer || reloading) return
        timer = setInterval(checkAndReload, 1000)
      }

      const stopPolling = () => {
        if (timer) { clearInterval(timer); timer = null }
      }

      const onOffline = () => startPolling()
      const onOnline = () => {
        stopPolling()
        void checkAndReload()
      }

      // DSH Web uses WebSocket for sessions; a close means the server went down.
      // We hook the global WebSocket to detect closes without polling constantly.
      const OriginalWebSocket = (window as any).WebSocket
      let wsCloseHandler: (() => void) | null = null
      try {
        if (OriginalWebSocket) {
          const Patched = function (this: any, url: string, protocols?: string | string[]) {
            const ws = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url)
            ws.addEventListener('close', () => {
              // Only treat DSH WebSocket closes (same origin) as server-down
              try {
                const u = new URL(url, window.location.href)
                if (u.host === window.location.host) startPolling()
              } catch { startPolling() }
            })
            ws.addEventListener('open', () => {
              // If we were polling and WS reopens, check immediately
              if (timer) void checkAndReload()
            })
            return ws
          } as any
          Patched.prototype = OriginalWebSocket.prototype
          Object.setPrototypeOf(Patched, OriginalWebSocket)
          ;(window as any).WebSocket = Patched
          wsCloseHandler = () => { (window as any).WebSocket = OriginalWebSocket }
        }
      } catch {}

      window.addEventListener('offline', onOffline)
      window.addEventListener('online', onOnline)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void checkAndReload()
      })

      // Host push: POST /dsh-maestro-supervisor-reload/reload (loopback) -> reload
      // The host plugin registers this RPC; the client also listens via fetch polling,
      // but a direct push is instant and avoids the 1s poll delay.
      // We poll for the push by listening to a custom event dispatched from the host's
      // `fetch` response — the host's `notify` after `restartWeb` will trigger it.
      const onHostPush = () => {
        if (!reloading) window.location.reload()
      }
      window.addEventListener('dsh-maestro-supervisor-reload', onHostPush as any)

      // If the page loads while the server is already down (e.g. hard refresh
      // during restart), start polling immediately.
      void fetch('/', { method: 'HEAD', cache: 'no-store' }).catch(() => startPolling())

      return () => {
        window.removeEventListener('offline', onOffline)
        window.removeEventListener('online', onOnline)
        window.removeEventListener('dsh-maestro-supervisor-reload', onHostPush as any)
        if (timer) clearInterval(timer)
        if (wsCloseHandler) wsCloseHandler()
      }
    }, 'supervisor:auto-reload')
  } catch {}
}
