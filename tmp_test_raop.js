import AirplaySender from '@lox-audioserver/node-airplay-sender';

console.log('AirplaySender imported');
try {
    const sender = new AirplaySender();
    console.log('Sender instance created');
} catch (e) {
    console.error('Failed to create sender:', e.message);
}
