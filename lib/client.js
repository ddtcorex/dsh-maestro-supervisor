window.__ModuleLoader__.load({ id: "@ddtcorex/dsh-maestro-supervisor", factory: (require) => {
var __modules = {};
__modules["auto-reload.js"] = function (require, module, exports) {
"use strict";
/**
 * dsh-maestro-supervisor — client auto-reload for DSH Web after restart.
 * Hybrid: polls `HEAD /` when the server is down (offline/WebSocket close)
 * and reloads as soon as it is back. The host also pushes a reload via
 * `POST /dsh-maestro-supervisor-reload` (loopback) when it recovers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.apply = apply;
function apply(ctx) {
    try {
        ctx.effect(() => {
            let timer = null;
            let reloading = false;
            const checkAndReload = async () => {
                if (reloading)
                    return;
                try {
                    const res = await fetch('/', { method: 'HEAD', cache: 'no-store' });
                    if (res.ok) {
                        reloading = true;
                        if (timer) {
                            clearInterval(timer);
                            timer = null;
                        }
                        window.location.reload();
                    }
                }
                catch {
                    // still down — keep polling
                }
            };
            const startPolling = () => {
                if (timer || reloading)
                    return;
                timer = setInterval(checkAndReload, 1000);
            };
            const stopPolling = () => {
                if (timer) {
                    clearInterval(timer);
                    timer = null;
                }
            };
            const onOffline = () => startPolling();
            const onOnline = () => {
                const wasPolling = !!timer;
                stopPolling();
                if (wasPolling)
                    void checkAndReload();
            };
            // DSH Web uses WebSocket for sessions; a close does NOT necessarily mean server down
            // (normal session end also closes WS). Only start polling if HEAD fetch actually fails.
            const OriginalWebSocket = window.WebSocket;
            let wsCloseHandler = null;
            try {
                if (OriginalWebSocket) {
                    const Patched = function (url, protocols) {
                        const ws = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
                        ws.addEventListener('close', () => {
                            try {
                                const u = new URL(url, window.location.href);
                                if (u.host !== window.location.host)
                                    return;
                            }
                            catch { /* ignore */ }
                            // Verify server is actually down before polling — avoid reload on normal WS close
                            fetch('/', { method: 'HEAD', cache: 'no-store' }).then(res => {
                                if (!res.ok)
                                    startPolling();
                            }).catch(() => startPolling());
                        });
                        ws.addEventListener('open', () => {
                            // If we were polling and WS reopens, check immediately
                            if (timer)
                                void checkAndReload();
                        });
                        return ws;
                    };
                    Patched.prototype = OriginalWebSocket.prototype;
                    Object.setPrototypeOf(Patched, OriginalWebSocket);
                    window.WebSocket = Patched;
                    wsCloseHandler = () => { window.WebSocket = OriginalWebSocket; };
                }
            }
            catch { }
            window.addEventListener('offline', onOffline);
            window.addEventListener('online', onOnline);
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && timer)
                    void checkAndReload();
            });
            // Host push: POST /dsh-maestro-supervisor-reload/reload (loopback) -> reload
            // The host plugin registers this RPC; the client also listens via fetch polling,
            // but a direct push is instant and avoids the 1s poll delay.
            // We poll for the push by listening to a custom event dispatched from the host's
            // `fetch` response — the host's `notify` after `restartWeb` will trigger it.
            const onHostPush = () => {
                if (!reloading)
                    window.location.reload();
            };
            window.addEventListener('dsh-maestro-supervisor-reload', onHostPush);
            // If the page loads while the server is already down (e.g. hard refresh
            // during restart), start polling immediately.
            void fetch('/', { method: 'HEAD', cache: 'no-store' }).catch(() => startPolling());
            return () => {
                window.removeEventListener('offline', onOffline);
                window.removeEventListener('online', onOnline);
                window.removeEventListener('dsh-maestro-supervisor-reload', onHostPush);
                if (timer)
                    clearInterval(timer);
                if (wsCloseHandler)
                    wsCloseHandler();
            };
        }, 'supervisor:auto-reload');
    }
    catch { }
}
};
__modules["index.js"] = function (require, module, exports) {
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./auto-reload.js"), exports);
};
var __cache = {};
function __localRequire(id) {
  if (id.charCodeAt(0) !== 46) return require(id);
  id = id.slice(2);
  var cached = __cache[id];
  if (cached) return cached.exports;
  var module = { exports: {} };
  __cache[id] = module;
  __modules[id](__localRequire, module, module.exports);
  return module.exports;
}
var module = { exports: {} };
__modules["index.js"](__localRequire, module, module.exports);
return module.exports; } });
