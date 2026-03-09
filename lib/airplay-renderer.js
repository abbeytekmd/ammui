import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const lox = require('@lox-audioserver/node-airplay-sender');
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';

// Assume ffmpeg is installed on the system and available in the PATH
ffmpeg.setFfmpegPath('ffmpeg');

export default class AirPlayRenderer {
    constructor(device) {
        this.device = device;
        this.udn = device.udn;
        this.friendlyName = device.friendlyName;
        // Parse IP and port from location (airplay://ip:port)
        try {
            const url = new URL(device.location);
            this.host = url.hostname;
            this.port = parseInt(url.port || 5000, 10);
        } catch (e) {
            console.error(`[AirPlay] Invalid device location: ${device.location}`);
            this.host = '';
            this.port = 5000;
        }

        this.sender = null;
        this.ffmpegCommand = null;
        this.playlist = [];
        this.currentIndex = -1;
        this.volume = device.volume !== undefined ? device.volume : 15;
        this.isPlaying = false;

        console.log(`[AirPlay] Initialized RAOP renderer for ${this.friendlyName} (${this.host}:${this.port})`);
    }

    async getPlaylist() {
        return this.playlist;
    }

    async clearPlaylist() {
        this.playlist = [];
        this.currentIndex = -1;
        this.isPlaying = false;
        await this.stop();
    }

    async insertTrack(track, afterId) {
        const newTrack = { ...track, id: Math.random().toString(36).substr(2, 9) };
        if (afterId === 0 || !afterId) {
            this.playlist.push(newTrack);
        } else {
            const index = this.playlist.findIndex(t => t.id === afterId);
            if (index !== -1) {
                this.playlist.splice(index + 1, 0, newTrack);
            } else {
                this.playlist.push(newTrack);
            }
        }
        return newTrack.id;
    }

    async deleteTrack(id) {
        const index = this.playlist.findIndex(t => t.id === id);
        if (index !== -1) {
            this.playlist.splice(index, 1);
            if (this.currentIndex === index) {
                this.currentIndex = -1;
                await this.stop();
            } else if (this.currentIndex > index) {
                this.currentIndex--;
            }
        }
    }

    async getIdArray() {
        return this.playlist.map(t => t.id);
    }

    async seekId(id) {
        const index = this.playlist.findIndex(t => t.id === id);
        if (index !== -1) {
            this.currentIndex = index;
            await this.playTrack(this.playlist[index]);
        }
    }

    async playTrack(track) {
        console.log(`[AirPlay] Attempting to play on ${this.friendlyName}: "${track.title}"`);
        console.log(`[AirPlay] URI: ${track.uri}`);

        await this.stop(); // Stop any previous playback

        this.isPlaying = true;

        if (!this.host) throw new Error('No host IP for device');

        try {
            this.sender = lox.start({
                host: this.host,
                port: this.port,
                airplay2: false, // Force backward compatible AirPlay 1 RAOP
                name: 'AMMUI Sender',
                volume: this.volume
            }, (evt) => {
                if (evt && evt.event === 'error') {
                    console.error(`[AirPlay] Sender error for ${this.friendlyName}:`, evt);
                }
            });

            this.sender.setMetadata({
                title: track.title || 'Unknown Title',
                artist: track.artist || 'Unknown Artist',
                album: track.album || 'Unknown Album'
            });

            if (this.volume !== undefined) {
                this.sender.setVolume(this.volume);
            }

            console.log(`[AirPlay] Spawning ffmpeg to transcode ${track.uri}...`);
            this.ffmpegCommand = ffmpeg(track.uri)
                // Use -re to read input at native frame rate. 
                // This prevents ffmpeg from instantly transcoding the whole file and ending the stream prematurely.
                .inputOptions(['-re'])
                .audioCodec('pcm_s16le')
                .audioChannels(2)
                .audioFrequency(44100)
                .format('s16le')
                .on('error', (err) => {
                    console.error(`[AirPlay] ffmpeg error: ${err.message}`);
                    if (this.isPlaying && err.message !== 'Output stream closed') {
                        this.stop();
                    }
                })
                .on('end', () => {
                    console.log(`[AirPlay] Track ended.`);
                    this.playNext();
                });

            const stream = this.ffmpegCommand.pipe();
            this.sender.pipeStream(stream);


        } catch (err) {
            console.error(`[AirPlay] Play failed: ${err.message}`);
            this.isPlaying = false;
            throw err;
        }
    }

    playNext() {
        if (this.currentIndex !== -1 && this.currentIndex < this.playlist.length - 1) {
            this.currentIndex++;
            this.playTrack(this.playlist[this.currentIndex]).catch(console.error);
        } else {
            this.stop();
        }
    }

    async play() {
        if (this.currentIndex === -1 && this.playlist.length > 0) {
            this.currentIndex = 0;
            await this.playTrack(this.playlist[this.currentIndex]);
        } else if (this.currentIndex !== -1 && this.playlist[this.currentIndex]) {
            await this.playTrack(this.playlist[this.currentIndex]);
        }
    }

    async pause() {
        console.warn(`[AirPlay] Pause not fully supported via RAOP alone (requires tearing down stream). Stopping instead.`);
        this.stop();
    }

    async stop() {
        this.isPlaying = false;
        try {
            if (this.ffmpegCommand) {
                this.ffmpegCommand.kill('SIGKILL');
                this.ffmpegCommand = null;
            }
            if (this.sender) {
                this.sender.stop();
                this.sender = null;
            }
        } catch (e) {
            console.warn(`[AirPlay] Stop cleanup failed: ${e.message}`);
        }
    }

    async getVolume() {
        return this.volume;
    }

    async setVolume(volume) {
        this.volume = volume;
        try {
            if (this.sender) {
                this.sender.setVolume(volume);
            }
        } catch (e) {
            console.warn(`[AirPlay] Set volume failed: ${e.message}`);
        }
    }

    async getCurrentStatus() {
        const track = this.currentIndex !== -1 ? this.playlist[this.currentIndex] : null;
        return {
            transportState: this.isPlaying ? 'Playing' : 'Stopped',
            title: track ? track.title : '',
            artist: track ? track.artist : '',
            album: track ? track.album : '',
            uri: track ? track.uri : '',
            position: 0,
            duration: track ? (track.duration || 0) : 0,
            volume: this.volume,
            trackId: track ? track.id : null
        };
    }

    async seekTime(seconds) {
        console.warn(`[AirPlay] Seek time not supported via RAOP alone right now.`);
    }
}
