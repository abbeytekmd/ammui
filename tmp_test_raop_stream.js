import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const lox = require('@lox-audioserver/node-airplay-sender');

console.log('Starting LoxAirplaySender test on 1030 using a test stream');

const sender = lox.start({
    host: '192.168.0.216',
    port: 1030,
    airplay2: false,
    log: (level, msg) => console.log(`[${level}]`, msg)
}, (evt) => {
    console.log('EVENT:', evt);
});

sender.setMetadata({
    title: "Test Track",
    artist: "AMMUI",
    album: "Diagnostics"
});

// Create 10 seconds of 44.1kHz 16-bit stereo silence/tone
const pcmChunk = Buffer.alloc(44100 * 2 * 2); // 1 sec of zeroes (silence)

for (let i = 0; i < 44100 * 2; i++) {
    // Fill with simple tone just to prove it works
    const sample = Math.sin(i * Math.PI * 2 * 440 / 44100) * 10000;
    pcmChunk.writeInt16LE(sample, i * 2); // Left
    // pcmChunk.writeInt16LE(sample, i * 2 + 2); // Right (not aligning correctly in loop for stereo, but silent is fine too)
}

const pcmChunkSilence = Buffer.alloc(44100 * 2 * 2);

let sentCount = 0;
const interval = setInterval(() => {
    sender.sendPcm(pcmChunkSilence);
    console.log('Sent 1 sec chunk...');
    sentCount++;
    if (sentCount > 10) {
        clearInterval(interval);
        sender.stop();
        console.log('Done.');
    }
}, 1000);

