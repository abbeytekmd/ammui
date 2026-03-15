export default class VirtualRenderer {
    constructor(device) {
        this.device = device;
        this.playlist = [];
        this.transportState = 'Stopped';
        this.volume = device.volume !== undefined ? device.volume : 50;
        this.position = 0;
        this.duration = 0;
        this.lastUpdateTime = Date.now();
    }

    async getVolume() { return this.volume; }
    async setVolume(v) {
        console.log(`[COMMAND] Sending SET_VOLUME command to ${this.device.friendlyName} (Virtual) (volume: ${v})`);
        this.volume = v;
    }

    async getEQ() { return { bass: 0, treble: 0 }; }
    async setEQ() { }

    async getPlaylist() { return this.playlist; }

    async insertTrack(track, afterId) {
        const newId = Date.now() + Math.floor(Math.random() * 1000);
        const newTrack = { ...track, id: newId };

        if (!afterId || afterId == 0) {
            this.playlist.push(newTrack);
        } else {
            const index = this.playlist.findIndex(t => t.id == afterId);
            if (index === -1) this.playlist.push(newTrack);
            else this.playlist.splice(index + 1, 0, newTrack);
        }
        return newId;
    }

    async clearPlaylist() {
        this.playlist = [];
        this.currentTrackId = null;
        this.transportState = 'Stopped';
    }

    async deleteTrack(id) {
        this.playlist = this.playlist.filter(t => t.id != id);
        if (this.currentTrackId == id) {
            this.currentTrackId = null;
            this.transportState = 'Stopped';
        }
    }

    async getIdArray() {
        return this.playlist.map(t => t.id);
    }

    async play() {
        console.log(`[COMMAND] Sending PLAY command to ${this.device.friendlyName} (Virtual)`);
        this.transportState = 'Playing';
        this.lastUpdateTime = Date.now();
    }

    async pause() {
        console.log(`[COMMAND] Sending PAUSE command to ${this.device.friendlyName} (Virtual)`);
        this.transportState = 'Paused';
    }

    async stop() {
        console.log(`[COMMAND] Sending STOP command to ${this.device.friendlyName} (Virtual)`);
        this.transportState = 'Stopped';
        this.position = 0;
    }

    async next() {
        console.log(`[COMMAND] Sending NEXT command to ${this.device.friendlyName} (Virtual)`);
        const index = this.playlist.findIndex(t => t.id == this.currentTrackId);
        if (index !== -1 && index < this.playlist.length - 1) {
            this.currentTrackId = this.playlist[index + 1].id;
        }
    }

    async previous() {
        console.log(`[COMMAND] Sending PREVIOUS command to ${this.device.friendlyName} (Virtual)`);
        const index = this.playlist.findIndex(t => t.id == this.currentTrackId);
        if (index > 0) {
            this.currentTrackId = this.playlist[index - 1].id;
        }
    }

    async seekId(id) {
        console.log(`[COMMAND] Sending SEEK_ID command to ${this.device.friendlyName} (Virtual) (id: ${id})`);
        this.currentTrackId = id;
        this.transportState = 'Playing';
        this.position = 0;
        const track = this.playlist.find(t => t.id == id);
        if (track) {
            // duration is often a string like "0:03:45"
            this.duration = this._parseTime(track.duration);
        }
    }

    async seekTime(seconds) {
        console.log(`[COMMAND] Sending SEEK_TIME command to ${this.device.friendlyName} (Virtual) (seconds: ${seconds})`);
        this.position = seconds;
    }

    async getCurrentStatus() {
        return {
            trackId: this.currentTrackId,
            transportState: this.transportState,
            duration: this.duration,
            relTime: this.position
        };
    }

    _parseTime(time) {
        if (!time) return 0;
        if (typeof time === 'number') return time;
        const parts = time.split(':');
        if (parts.length === 3) return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
        if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
        return parseInt(time) || 0;
    }
}
