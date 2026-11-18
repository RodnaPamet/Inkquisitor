/**
 * The mailer: the console sink logs no part of the message an author could
 * have written, the stub records, and SMTP is selected only by SMTP_HOST.
 */
import { pinoInstance } from '@/lib/observability/logger';
import {
    ConsoleEmailProvider,
    NodemailerProvider,
    StubEmailProvider,
    _resetMailerForTesting,
    getEmailProvider,
    initMailerFromEnv,
    sendEmail,
    setEmailProvider,
    smtpTransportOptions,
} from '@/lib/mailer';

afterEach(() => {
    jest.restoreAllMocks();
    _resetMailerForTesting();
    delete process.env.SMTP_HOST;
});

it('the console sink logs counts and domains, never the address, subject or body', async () => {
    const logged: string[] = [];
    jest.spyOn(pinoInstance, 'debug').mockImplementation(((o: unknown, m?: string) => {
        logged.push(JSON.stringify([o, m]));
    }) as never);
    const delivery = await sendEmail({
        to: 'mara.ashgrove@example.com',
        subject: 'Your bible entry: The fire at Ashgrove',
        text: 'Mara never forgave her brother.',
    });
    expect(delivery).toEqual({ delivered: false });
    const out = logged.join('\n');
    expect(out).toContain('example.com');
    expect(out).not.toContain('mara.ashgrove');
    expect(out).not.toContain('Ashgrove');
    expect(out).not.toContain('forgave');
});

it('the stub records what was sent and reports delivery', async () => {
    const stub = new StubEmailProvider();
    setEmailProvider(stub);
    expect(await sendEmail({ to: 'a@b.c', subject: 's', text: 't' })).toEqual({ delivered: true });
    expect(stub.sentMessages).toHaveLength(1);
});

it('SMTP is selected only when SMTP_HOST is set (nothing is sent)', () => {
    initMailerFromEnv();
    expect(getEmailProvider()).toBeInstanceOf(ConsoleEmailProvider);
    process.env.SMTP_HOST = 'smtp.invalid';
    jest.spyOn(pinoInstance, 'info').mockImplementation((() => undefined) as never);
    initMailerFromEnv();
    expect(getEmailProvider()).toBeInstanceOf(NodemailerProvider);
});

describe('SMTP transport options', () => {
    it('requires TLS: implicit on 465, STARTTLS required on every other port, certificates verified', () => {
        const submission = smtpTransportOptions({ host: 'smtp.example.com', port: 587, user: 'u', pass: 'p' }, 'production');
        expect(submission).toMatchObject({ secure: false, requireTLS: true, tls: { rejectUnauthorized: true } });
        expect(smtpTransportOptions({ host: 'smtp.example.com', port: 25 }, 'development').requireTLS).toBe(true);
        expect(smtpTransportOptions({ host: 'smtp.example.com', port: 465 }, 'production')).toMatchObject({
            secure: true,
            requireTLS: false,
        });
    });

    it('only a loopback mail catcher outside production may speak plain SMTP', () => {
        expect(smtpTransportOptions({ host: 'localhost', port: 1025 }, 'development').requireTLS).toBe(false);
        expect(smtpTransportOptions({ host: '127.0.0.1', port: 1025 }, 'test').requireTLS).toBe(false);
        expect(smtpTransportOptions({ host: 'localhost', port: 1025 }, 'production').requireTLS).toBe(true);
        expect(smtpTransportOptions({ host: 'mail.internal', port: 1025 }, 'development').requireTLS).toBe(true);
    });
});
