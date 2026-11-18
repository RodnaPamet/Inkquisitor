/**
 * The clamd INSTREAM client against an in-process fake clamd on loopback.
 *
 * The fake speaks the protocol (zINSTREAM\0, length-prefixed chunks, a zero
 * terminator) and answers OK or FOUND, so the parser is exercised end to end
 * — including the inflect-compliance bug where a signature containing "OK"
 * (`Win.Trojan.Broker FOUND`) read as clean.
 */
import net from 'node:net';
import { scanBuffer, isClamavAvailable } from '@/lib/storage/av-scan';

let server: net.Server;
let reply = 'stream: OK';
let received = Buffer.alloc(0);

beforeAll(async () => {
    server = net.createServer((socket) => {
        let buf = Buffer.alloc(0);
        socket.on('data', (d: Buffer) => {
            buf = Buffer.concat([buf, d]);
            if (buf.toString().startsWith('zPING')) {
                socket.end('PONG\0');
                return;
            }
            // Terminator: four zero bytes after the command and chunks.
            if (buf.length >= 14 && buf.subarray(buf.length - 4).equals(Buffer.alloc(4))) {
                received = buf;
                socket.end(`${reply}\0`);
            }
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.CLAMAV_HOST = `127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});

afterAll(async () => {
    delete process.env.CLAMAV_HOST;
    await new Promise((r) => server.close(r));
});

it('answers PING', async () => {
    expect(await isClamavAvailable()).toBe(true);
});

it('a clean reply is CLEAN, and the bytes were streamed with the protocol framing', async () => {
    reply = 'stream: OK';
    const result = await scanBuffer(Buffer.from('chapter one'));
    expect(result).toMatchObject({ status: 'CLEAN', engine: 'clamav' });
    expect(received.subarray(0, 10).toString()).toBe('zINSTREAM\0');
    expect(received.readUInt32BE(10)).toBe('chapter one'.length);
});

it('FOUND is INFECTED even when the signature contains "OK"', async () => {
    reply = 'stream: Win.Trojan.Broker FOUND';
    const result = await scanBuffer(Buffer.from('x'));
    expect(result).toMatchObject({ status: 'INFECTED', threat: 'Win.Trojan.Broker' });
});

it('an unexpected reply is an ERROR, not clean', async () => {
    reply = 'INSTREAM size limit exceeded';
    expect((await scanBuffer(Buffer.from('x'))).status).toBe('ERROR');
});
