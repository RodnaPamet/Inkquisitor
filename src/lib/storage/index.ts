/**
 * Storage — the provider factory, workspace-scoped object keys, upload limits.
 *
 * Usage:
 *   import { getStorageProvider, buildWorkspaceObjectKey } from '@/lib/storage';
 *   const key = buildWorkspaceObjectKey(workspaceId, 'imports', 'notes.md');
 *   const { sha256, sizeBytes } = await getStorageProvider().write(key, buffer, { mimeType: 'text/markdown' });
 *
 * Every object lives under `workspaces/<workspaceId>/`, so a key names its
 * owner and `assertWorkspaceKey` can refuse a key from another workspace
 * before any byte is read (decision D4 — isolation at every layer, not only
 * row-level security).
 *
 * The provider defaults to `local` (inflect-compliance defaults to `s3`):
 * development needs no bucket. Production may run `local` on a persistent
 * volume; it logs a warning so the choice is visible.
 *
 * Adapted from inflect-compliance's `src/lib/storage/index.ts`: tenant →
 * workspace, the domains are Inkquisitor's, and the legacy helpers are gone.
 */
import crypto from 'crypto';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { badRequest, workspaceIsolationViolation } from '@/lib/errors/types';
import { LocalStorageProvider } from './local-provider';
import type { StorageProvider, StorageProviderType } from './types';

export type {
    StorageProvider,
    StorageProviderType,
    WriteResult,
    WriteOptions,
    HeadResult,
    DownloadUrlOptions,
    UploadUrlOptions,
    SignedUploadTarget,
} from './types';

const providers = new Map<StorageProviderType, StorageProvider>();

/** The provider for a name. The S3 SDK is loaded only when S3 is asked for. */
export function getProviderByName(name: StorageProviderType): StorageProvider {
    const cached = providers.get(name);
    if (cached) return cached;
    let provider: StorageProvider;
    if (name === 's3') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: the AWS SDK loads only when S3 is configured
        const { S3StorageProvider } = require('./s3-provider') as typeof import('./s3-provider');
        provider = new S3StorageProvider();
    } else {
        provider = new LocalStorageProvider();
    }
    providers.set(name, provider);
    return provider;
}

/** The configured provider. Read a stored object with the provider that wrote it. */
export function getStorageProvider(): StorageProvider {
    const type: StorageProviderType = env.STORAGE_PROVIDER ?? 'local';
    if (type === 'local' && env.NODE_ENV === 'production' && !providers.has('local')) {
        logger.warn('Local filesystem storage in production: make sure FILE_STORAGE_ROOT is a persistent volume', {
            component: 'storage',
        });
    }
    return getProviderByName(type);
}

/** @internal test-only */
export function resetStorageProviders(): void {
    providers.clear();
}

// ─── Object keys ─────────────────────────────────────────────────────

/** Strip directory components, control characters and runs of dots; cap the length. */
export function sanitizeFileName(name: string): string {
    const base = name.split(/[\\/]/).pop() || name;
    return base
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\.{2,}/g, '.')
        .slice(0, 200);
}

export const STORAGE_DOMAINS = ['imports', 'exports', 'attachments', 'temp', 'general'] as const;
export type StorageDomain = (typeof STORAGE_DOMAINS)[number];

/**
 * `workspaces/<workspaceId>/<domain>/<yyyy>/<mm>/<uuid>_<sanitizedName>`.
 * The UUID makes the key unique; the date partitions listings.
 */
export function buildWorkspaceObjectKey(
    workspaceId: string,
    domain: StorageDomain,
    originalName: string,
    opts?: { date?: Date },
): string {
    if (!workspaceId || typeof workspaceId !== 'string' || workspaceId.includes('/')) {
        throw badRequest('A workspace id is required for an object key');
    }
    if (!(STORAGE_DOMAINS as readonly string[]).includes(domain)) {
        throw badRequest(`Invalid storage domain: ${domain}. Must be one of: ${STORAGE_DOMAINS.join(', ')}`);
    }
    if (!originalName || typeof originalName !== 'string') {
        throw badRequest('A file name is required for an object key');
    }
    const now = opts?.date ?? new Date();
    const yyyy = now.getUTCFullYear().toString();
    const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
    return `workspaces/${workspaceId}/${domain}/${yyyy}/${mm}/${crypto.randomUUID()}_${sanitizeFileName(originalName)}`;
}

const WORKSPACE_KEY_RE = new RegExp(
    `^workspaces/([^/]+)/(${STORAGE_DOMAINS.join('|')})/\\d{4}/\\d{2}/[a-f0-9-]+_.+$`,
);

/** Throw unless `pathKey` belongs to `workspaceId`. Call before any storage operation. */
export function assertWorkspaceKey(pathKey: string, workspaceId: string): void {
    if (!workspaceId || !pathKey.startsWith(`workspaces/${workspaceId}/`) || pathKey.includes('..')) {
        throw workspaceIsolationViolation('This object does not belong to the workspace');
    }
}

export function parseWorkspaceKey(pathKey: string): { workspaceId: string; domain: StorageDomain } | null {
    const m = WORKSPACE_KEY_RE.exec(pathKey);
    return m ? { workspaceId: m[1], domain: m[2] as StorageDomain } : null;
}

// ─── Upload limits ───────────────────────────────────────────────────

/** Applied when FILE_MAX_SIZE_BYTES is unset — 50 MB. */
export const FILE_MAX_SIZE_DEFAULT_BYTES = 50 * 1024 * 1024;

/** The types an author is expected to bring: documents, notes and images. */
export const DEFAULT_ALLOWED_MIME: readonly string[] = [
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
    'application/zip',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/epub+zip',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
];

export function maxFileSizeBytes(): number {
    return env.FILE_MAX_SIZE_BYTES ?? FILE_MAX_SIZE_DEFAULT_BYTES;
}

export function allowedMimeTypes(): readonly string[] {
    const configured = env.FILE_ALLOWED_MIME?.split(',').map((s) => s.trim()).filter(Boolean);
    return configured && configured.length > 0 ? configured : DEFAULT_ALLOWED_MIME;
}

export function isAllowedMime(mimeType: string): boolean {
    return allowedMimeTypes().includes(mimeType);
}

export function isAllowedSize(sizeBytes: number): boolean {
    return sizeBytes > 0 && sizeBytes <= maxFileSizeBytes();
}
