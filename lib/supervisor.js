// Imported first by server.js. Run directly (from a terminal or a shortcut, rather than by a service
// that sets AMMUI_SUPERVISED=1), this process becomes a small supervisor: it runs the real server as
// a child in the same window and starts it again when it exits to restart (after an update, or a
// change of port in Settings). So Restart restarts here, instead of leaving a copy in the background.
//
// It waits synchronously, so nothing else in server.js (or the modules it imports) loads in this
// process. Ctrl+C reaches the server too, which shuts down and exits; then so does this.
import { spawnSync } from 'child_process';

// The exit code that means "start me again" (anything else ends the supervisor with that code)
export const RESTART_EXIT_CODE = 75;

if (process.env.AMMUI_SUPERVISED !== '1') {
    process.on('SIGINT', () => { }); // the server handles Ctrl+C; this just waits for it to exit
    const env = { ...process.env, AMMUI_SUPERVISED: '1', AMMUI_RESTART_EXIT: String(RESTART_EXIT_CODE) };
    const args = [...process.execArgv, ...process.argv.slice(1)];
    for (;;) {
        const run = spawnSync(process.execPath, args, { stdio: 'inherit', env });
        if (run.error) {
            console.error('Could not start the AMMUI server:', run.error.message);
            process.exit(1);
        }
        if (run.status !== RESTART_EXIT_CODE) process.exit(run.status ?? 1);
        console.log('\nRestarting AMMUI...\n');
    }
}
