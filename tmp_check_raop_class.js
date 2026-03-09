import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const AirplaySender = require('@lox-audioserver/node-airplay-sender');
const sender = new AirplaySender.LoxAirplaySender('192.168.0.216', 1030); // use port 1030 perhaps? Or 5000? Let's check constructor signature.
console.log('sender keys:', Object.keys(sender));
console.log('sender prototype:', Object.getOwnPropertyNames(Object.getPrototypeOf(sender)));
