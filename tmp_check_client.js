import airplay from 'airplay-js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

try {
    const Client = require('airplay-js/airplay/client').Client;
    console.log('Client found:', typeof Client);
} catch (e) {
    console.log('Client not found by direct require:', e.message);
}

console.log('AirPlay keys:', Object.keys(airplay));
