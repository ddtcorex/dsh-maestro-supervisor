import { Supervisor } from './supervisor.js';
import { pollHealth } from './health-poller.js';
import { writeLKG, verifyLKG } from './snapshot.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
export async function runCli(args) {
    const cmd = args[2] ?? '--help';
    if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
        console.log(`Usage: dsh-web-supervisor <command>

Commands:
  daemon     Run supervisor daemon (poll every 3s)
  status     Show health + LKG status
  logs       Tail supervisor reports
  rollback --to <ts>  Rollback to LKG <ts>
`);
        return;
    }
    if (cmd === 'status') {
        const health = await pollHealth();
        console.log(`up: ${health.up}, httpCode: ${health.httpCode}, error: ${health.error ?? 'none'}`);
        const lkgRoot = path.join(os.homedir(), '.dsh/.supervisor/lkg');
        if (fs.existsSync(lkgRoot)) {
            const entries = fs.readdirSync(lkgRoot).sort();
            console.log(`LKG: ${entries.length} snapshots, latest: ${entries[entries.length - 1] ?? 'none'}`);
            if (entries.length) {
                const ok = await verifyLKG(path.join(lkgRoot, entries[entries.length - 1])).catch(() => false);
                console.log(`latest LKG valid: ${ok}`);
            }
        }
        else {
            console.log('LKG: none');
        }
        return;
    }
    if (cmd === 'daemon') {
        console.log('[supervisor] starting daemon — poll every 3s, Ctrl+C to stop');
        const dshHome = path.join(os.homedir(), '.dsh');
        const lkgRoot = path.join(os.homedir(), '.dsh/.supervisor/lkg');
        const failedRoot = path.join(os.homedir(), '.dsh/.supervisor/failed');
        const reportsRoot = path.join(os.homedir(), '.dsh/.supervisor/reports');
        const supervisor = new Supervisor({
            pollHealth: () => pollHealth(),
            writeLKG: () => writeLKG(dshHome, lkgRoot),
            writeFailed: () => writeLKG(dshHome, failedRoot),
            writeReport: async ({ ts, health, action }) => {
                const { writeReport } = await import('./report.js');
                return writeReport({ reportsRoot, ts, health, gitDiff: '', logTail: '', action });
            },
            rollback: async () => {
                // Find latest LKG and restore
                const entries = fs.existsSync(lkgRoot) ? fs.readdirSync(lkgRoot).sort() : [];
                if (!entries.length)
                    throw new Error('no LKG to rollback to');
                const latest = entries[entries.length - 1];
                const src = path.join(lkgRoot, latest);
                // naive restore: copy files back
                for (const entry of fs.readdirSync(src)) {
                    if (entry === 'manifest.json')
                        continue;
                    fs.cpSync(path.join(src, entry), path.join(dshHome, entry), { recursive: true, force: true });
                }
                console.log(`[supervisor] rolled back to ${latest}`);
            },
            notify: async (msg) => console.log(`[notify] ${msg}`),
            intervalMs: 3000,
        });
        supervisor.start();
        // keep process alive
        await new Promise(() => { });
    }
    console.log(`unknown command: ${cmd} — try --help`);
}
