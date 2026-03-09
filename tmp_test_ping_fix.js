import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Client = require('airplay-js/airplay/client').Client;

// Safety patch for fragile airplay-js parser which crashes on malformed HTTP headers
const originalParseResponse = Client.prototype.parseResponse;
Client.prototype.parseResponse = function (resStr) {
    try {
        return originalParseResponse.call(this, resStr);
    } catch (e) {
        return { statusCode: 500, headers: {}, body: '' };
    }
};

Client.prototype.ping = function () {
    console.log('ping monkeypatch executed');
    this.emit('ping', false);
    const fn = this.responseQueue.shift();
    if (fn) fn({ statusCode: 200, headers: {}, body: '' }); // mock response
    return this;
};

console.log('Connecting...');
const client = new Client({ host: '192.168.0.216', port: 1030 }, () => {
    console.log('Connected! (callback executed)');
    process.exit(0);
});
