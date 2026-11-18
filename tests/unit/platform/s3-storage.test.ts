/**
 * The S3 provider, with the AWS client's `send` stubbed so nothing touches
 * the network: selection by STORAGE_PROVIDER, the bucket requirement, the
 * size cap on both inputs (nothing sent over it), the checksum it sends and
 * returns, and the signed URLs' lifetime and Content-Disposition. Presigning
 * is local computation over the explicit test credentials below.
 */
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getStorageProvider, resetStorageProviders } from '@/lib/storage';
import { S3StorageProvider } from '@/lib/storage/s3-provider';
import { SIGNED_DOWNLOAD_URL_TTL_SECONDS, SIGNED_UPLOAD_URL_TTL_SECONDS } from '@/lib/storage/signed-url-policy';

const S3_ENV = {
    STORAGE_PROVIDER: 's3',
    S3_BUCKET: 'ink-test-bucket',
    S3_REGION: 'eu-west-1',
    S3_ACCESS_KEY_ID: 'test-key-id',
    S3_SECRET_ACCESS_KEY: 'test-signing-value',
};

let sent: unknown[];
beforeEach(() => {
    Object.assign(process.env, S3_ENV);
    resetStorageProviders();
    sent = [];
    jest.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
        sent.push(command);
        return {};
    }) as never);
});
afterEach(() => {
    jest.restoreAllMocks();
    for (const k of Object.keys(S3_ENV)) delete process.env[k];
    resetStorageProviders();
});

const KEY = 'workspaces/ws1/imports/2026/03/x/manuscript.md';

it('STORAGE_PROVIDER=s3 selects the S3 provider', () => {
    expect(getStorageProvider()).toBeInstanceOf(S3StorageProvider);
    expect(getStorageProvider().name).toBe('s3');
});

it('refuses to construct without S3_BUCKET', () => {
    delete process.env.S3_BUCKET;
    expect(() => new S3StorageProvider()).toThrow(/S3_BUCKET/);
});

it('sends PutObject with the base64 SHA-256 and returns the hex digest', async () => {
    const body = Buffer.from('chapter one');
    const result = await new S3StorageProvider().write(KEY, body, { mimeType: 'text/markdown' });
    const digest = crypto.createHash('sha256').update(body).digest();
    expect(result).toEqual({ sha256: digest.toString('hex'), sizeBytes: body.length });
    expect(sent).toHaveLength(1);
    const put = sent[0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
        Bucket: 'ink-test-bucket',
        Key: KEY,
        ContentType: 'text/markdown',
        ChecksumSHA256: digest.toString('base64'),
    });
});

it.each([
    ['a Buffer', () => Buffer.alloc(11)],
    ['a stream', () => Readable.from([Buffer.alloc(6), Buffer.alloc(6)])],
])('refuses %s over maxSizeBytes and sends nothing', async (_name, source) => {
    await expect(new S3StorageProvider().write(KEY, source(), { maxSizeBytes: 10 })).rejects.toThrow(/exceeds/);
    expect(sent).toEqual([]);
});

describe('signed URLs', () => {
    const expiresOf = (url: string) => Number(new URL(url).searchParams.get('X-Amz-Expires'));

    it('a download URL lives the policy lifetime by default, and never longer', async () => {
        const s3 = new S3StorageProvider();
        expect(expiresOf(await s3.createSignedDownloadUrl(KEY))).toBe(SIGNED_DOWNLOAD_URL_TTL_SECONDS);
        expect(expiresOf(await s3.createSignedDownloadUrl(KEY, { expiresIn: 3600 }))).toBe(SIGNED_DOWNLOAD_URL_TTL_SECONDS);
        expect(expiresOf(await s3.createSignedDownloadUrl(KEY, { expiresIn: 60 }))).toBe(60);
        expect(sent).toEqual([]);
    });

    it('a download URL carries a sanitised Content-Disposition', async () => {
        const url = await new S3StorageProvider().createSignedDownloadUrl(KEY, {
            downloadFilename: 'chapter "one"\r\nX-Injected: yes.md',
        });
        const disposition = new URL(url).searchParams.get('response-content-disposition') ?? '';
        expect(disposition).toMatch(/^attachment;/);
        expect(disposition).not.toMatch(/[\r\n]/);
        expect(disposition).not.toContain('"one"');
    });

    it('an upload target states its lifetime', async () => {
        const target = await new S3StorageProvider().createSignedUploadUrl(KEY, { mimeType: 'text/plain' });
        expect(target.method).toBe('PUT');
        expect(target.expiresIn).toBe(SIGNED_UPLOAD_URL_TTL_SECONDS);
        expect(expiresOf(target.url)).toBe(SIGNED_UPLOAD_URL_TTL_SECONDS);
    });
});
