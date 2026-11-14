// The peer link's games service: each server's family players and their recent Daily Word games,
// swapped so the Games tab on each shows everyone's attempts. What comes from another server is only
// shown, never playable here: it's kept apart from this server's own players (peer_game_snapshots,
// not game_players), and a player is only ever played on the server they belong to.
//
// A snapshot is { server: { id, name }, players: [{ id, name }], games: [{ player, day, guesses, status }] }
// with games from the last few days (days are local calendar days, so a server a timezone away can be
// a day ahead or behind).
//
// One link is enough for both ways: the server that connects pulls the other's snapshot and pushes
// its own, so the server it connects to has both too, without needing a link back.
//
// On the server connected to (gamesServiceRouter, at /peer/v1/games):
//   GET  /results  -> its own snapshot
//   POST /results  <- the connecting server's snapshot, kept as that server's
import express from 'express';

export const GAMES_SERVICE = 'games';
export const GAMES_SERVICE_VERSION = 1;

export const SNAPSHOT_DAYS = 3;         // games sent: today and the two days before
export const KEEP_MS = 3 * 86400000;    // a server not heard from in this long drops off the Games tab
const SYNC_MS = 5 * 60 * 1000;          // pulled and pushed this often...
const STALE_MS = 30 * 1000;             // ...or when the Games tab asks and it's been this long
const PUSH_DELAY_MS = 2000;             // after a guess here, so the other side sees it soon
const MAX_PLAYERS = 50;
const MAX_GAMES = MAX_PLAYERS * (SNAPSHOT_DAYS + 2);
const ID = /^[A-Za-z0-9._:-]{1,64}$/;

const cleanName = (v, max) => String(v ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);

// A snapshot from the other end, checked; throws on anything malformed
export function cleanSnapshot(data) {
    const bad = what => Object.assign(new Error(`Bad game results: ${what}`), { status: 400 });
    if (!data || typeof data !== 'object') throw bad('not an object');
    const id = String(data.server?.id ?? '');
    if (!ID.test(id)) throw bad('server id');
    const name = cleanName(data.server?.name, 80) || 'AMMUI';
    if (!Array.isArray(data.players) || data.players.length > MAX_PLAYERS) throw bad('players');
    if (!Array.isArray(data.games) || data.games.length > MAX_GAMES) throw bad('games');
    const players = [];
    const seen = new Set();
    for (const p of data.players) {
        const pid = String(p?.id ?? '');
        const pname = cleanName(p?.name, 40);
        if (!ID.test(pid) || !pname || seen.has(pid)) continue;
        seen.add(pid);
        players.push({ id: pid, name: pname });
    }
    const games = data.games.filter(g => seen.has(String(g?.player))
        && Number.isInteger(g.day) && g.day > 0
        && Array.isArray(g.guesses) && g.guesses.length <= 6 && g.guesses.every(w => /^[a-z]{5}$/.test(w))
        && ['playing', 'won', 'lost'].includes(g.status))
        .map(g => ({ player: String(g.player), day: g.day, guesses: [...g.guesses], status: g.status }));
    return { server: { id, name }, players, games };
}

// Served to logged-in peers. snapshot() gives this server's own; receive(snapshot) keeps another's.
export function gamesServiceRouter({ snapshot, receive, ownId }) {
    const router = express.Router();
    router.get('/results', (req, res) => res.json(snapshot()));
    router.post('/results', express.json({ limit: '256kb' }), (req, res) => {
        try {
            const s = cleanSnapshot(req.body);
            if (s.server.id === ownId()) return res.status(400).json({ error: 'That is this server' });
            receive(s);
            res.json({ ok: true });
        } catch (err) {
            res.status(err.status || 500).json({ error: err.message });
        }
    });
    return router;
}

// The connecting side: swaps snapshots with every linked server that offers the games service
export class GameResultsSync {
    constructor({ peers, snapshot, receive, ownId }) {
        Object.assign(this, { peers, snapshot, receive, ownId });
        this.lastSync = 0;
        this.running = null;
        this.pushTimer = null;
    }

    start() {
        setTimeout(() => this.syncAll(), 15000).unref?.();
        setInterval(() => this.syncAll(), SYNC_MS).unref?.();
    }

    linked() {
        return this.peers.summary().filter(p => p.services[GAMES_SERVICE]);
    }

    // Pull theirs and push ours, for every linked server, one at a time per server
    syncAll() {
        this.running ||= (async () => {
            this.lastSync = Date.now();
            const ours = this.snapshot();
            await Promise.all(this.linked().map(async p => {
                const svc = this.peers.service(p.id, GAMES_SERVICE);
                try {
                    const theirs = cleanSnapshot(await svc.getJson('/results', null, { timeout: 15000 }));
                    if (theirs.server.id !== this.ownId()) this.receive(theirs);
                    await svc.postJson('/results', ours, { timeout: 15000 });
                } catch (err) {
                    console.log(`[GAMES] Couldn't swap results with "${p.name}": ${err.message}`);
                }
            }));
        })().finally(() => { this.running = null; });
        return this.running;
    }

    // When the Games tab looks: sync if it's been a little while (without waiting for it)
    syncIfStale() {
        if (Date.now() - this.lastSync > STALE_MS) this.syncAll();
    }

    // After a guess here: send it on shortly, so a run of guesses goes in one sync
    pushSoon() {
        clearTimeout(this.pushTimer);
        this.pushTimer = setTimeout(() => this.syncAll(), PUSH_DELAY_MS);
        this.pushTimer.unref?.();
    }
}
