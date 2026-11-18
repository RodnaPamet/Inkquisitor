/**
 * Email — one provider seam, three providers.
 *
 *   ConsoleEmailProvider  development default: logs that a message was "sent"
 *   NodemailerProvider    SMTP, selected when SMTP_HOST is set
 *   StubEmailProvider     records messages, for tests
 *
 * The console sink logs the recipient's domain, the subject's length and the
 * message's size — never the body, the subject or the full address. An email
 * may quote what an author wrote (a share invitation, an export notice), and
 * author text never reaches a log line (roadmap rule 4). In production a send
 * that lands on the console sink is a dropped email, so it logs at WARN.
 *
 * Adapted from inflect-compliance's `src/lib/mailer.ts` (the `bodyPreview`
 * field and the undeliverable-system-user check are not carried).
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

export const DEFAULT_SENDER = 'Inkquisitor <no-reply@localhost>';

export interface EmailAttachment {
    filename: string;
    content: Buffer;
    contentType?: string;
}

export interface EmailMessage {
    to: string;
    subject: string;
    text: string;
    html?: string;
    /** Override the default sender. */
    from?: string;
    attachments?: EmailAttachment[];
}

export interface EmailProvider {
    send(msg: EmailMessage): Promise<void>;
}

/** The domain part of each address, for a log line that names no person. */
function recipientDomains(to: string): string[] {
    return to
        .split(',')
        .map((a) => a.trim().replace(/>$/, ''))
        .filter(Boolean)
        .map((a) => a.slice(a.lastIndexOf('@') + 1) || '(none)');
}

export class ConsoleEmailProvider implements EmailProvider {
    async send(msg: EmailMessage): Promise<void> {
        const fields = {
            component: 'mailer',
            recipientDomains: recipientDomains(msg.to),
            subjectChars: msg.subject.length,
            textChars: msg.text.length,
            htmlChars: msg.html?.length ?? 0,
            attachmentCount: msg.attachments?.length ?? 0,
        };
        if (env.NODE_ENV === 'production') {
            logger.warn('Email NOT delivered: the mailer is on the console sink (SMTP_HOST unset)', fields);
        } else {
            logger.debug('Email sent (development console sink)', fields);
        }
    }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface SmtpConfig {
    host: string;
    port: number;
    user?: string;
    pass?: string;
}

/**
 * The transport options, as a pure function so a test can read them.
 *
 * TLS is REQUIRED, never opportunistic: port 465 is implicit TLS (`secure`),
 * and on any other port `requireTLS` makes nodemailer refuse to authenticate
 * or send unless the server upgrades with STARTTLS. Without it, an on-path
 * attacker who strips the STARTTLS capability gets SMTP_USER / SMTP_PASS and
 * every message (which may quote an author's text) in cleartext. Certificate
 * verification stays on. The one exception is a LOOPBACK host outside
 * production — a local mail catcher, which speaks plain SMTP and never leaves
 * the machine.
 */
export function smtpTransportOptions(config: SmtpConfig, nodeEnv: string = env.NODE_ENV) {
    const implicitTls = config.port === 465;
    const localCatcher = nodeEnv !== 'production' && LOOPBACK_HOSTS.has(config.host.toLowerCase());
    return {
        host: config.host,
        port: config.port,
        secure: implicitTls,
        requireTLS: !implicitTls && !localCatcher,
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const },
        ...(config.user && config.pass ? { auth: { user: config.user, pass: config.pass } } : {}),
    };
}

export class NodemailerProvider implements EmailProvider {
    private readonly transporter: Transporter;
    private readonly from: string;

    constructor(config: SmtpConfig & { from: string }) {
        this.transporter = nodemailer.createTransport(smtpTransportOptions(config));
        this.from = config.from;
    }

    async send(msg: EmailMessage): Promise<void> {
        await this.transporter.sendMail({
            from: msg.from || this.from,
            to: msg.to,
            subject: msg.subject,
            text: msg.text,
            ...(msg.html ? { html: msg.html } : {}),
            ...(msg.attachments ? { attachments: msg.attachments } : {}),
        });
    }
}

export class StubEmailProvider implements EmailProvider {
    public sentMessages: EmailMessage[] = [];

    async send(msg: EmailMessage): Promise<void> {
        this.sentMessages.push(msg);
    }

    reset(): void {
        this.sentMessages = [];
    }
}

let provider: EmailProvider = new ConsoleEmailProvider();
let envInitAttempted = false;

export function setEmailProvider(p: EmailProvider): void {
    provider = p;
    envInitAttempted = true;
}

export function getEmailProvider(): EmailProvider {
    return provider;
}

/**
 * What a send did. `delivered` is false when the message went to the console
 * sink and so reached nobody: a caller that tells a person "we emailed it"
 * must read it.
 */
export interface EmailDelivery {
    delivered: boolean;
}

export async function sendEmail(msg: EmailMessage): Promise<EmailDelivery> {
    // Lazy init on the first real send: Next may load this module in a route
    // chunk that is not the instance `instrumentation.ts` initialised.
    if (!envInitAttempted && provider instanceof ConsoleEmailProvider) {
        envInitAttempted = true;
        initMailerFromEnv();
    }
    const transport = provider;
    await transport.send(msg);
    return { delivered: !(transport instanceof ConsoleEmailProvider) };
}

/** Select the SMTP transport when SMTP_HOST is configured. */
export function initMailerFromEnv(): void {
    const host = env.SMTP_HOST;
    if (host) {
        const port = env.SMTP_PORT ?? 587;
        const from = env.SMTP_FROM || DEFAULT_SENDER;
        provider = new NodemailerProvider({ host, port, user: env.SMTP_USER, pass: env.SMTP_PASS, from });
        envInitAttempted = true;
        logger.info('Mailer initialised: SMTP transport', {
            component: 'mailer',
            host,
            port,
            secure: port === 465,
            hasAuth: !!(env.SMTP_USER && env.SMTP_PASS),
        });
    } else if (env.NODE_ENV === 'production') {
        logger.warn('Mailer on the console sink: SMTP_HOST unset, so email will not be delivered', { component: 'mailer' });
    }
}

/** @internal test-only */
export function _resetMailerForTesting(): void {
    provider = new ConsoleEmailProvider();
    envInitAttempted = false;
}
