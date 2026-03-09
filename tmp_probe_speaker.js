import net from 'net';

const target = '192.168.0.216';
const ports = [7000, 5000, 1030, 1024, 1025];

async function checkPort(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(2000);
        socket.on('connect', () => {
            console.log(`Port ${port} is OPEN`);
            socket.destroy();
            resolve(true);
        });
        socket.on('timeout', () => {
            console.log(`Port ${port} is TIMEOUT`);
            socket.destroy();
            resolve(false);
        });
        socket.on('error', (err) => {
            console.log(`Port ${port} is CLOSED (${err.code})`);
            resolve(false);
        });
        socket.connect(port, target);
    });
}

console.log(`Probing ports on ${target}...`);
for (const port of ports) {
    await checkPort(port);
}
