import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const AirplaySender = require('@lox-audioserver/node-airplay-sender');
console.log('AirplaySender keys:', Object.keys(AirplaySender));
console.log('AirplaySender typeof:', typeof AirplaySender);
