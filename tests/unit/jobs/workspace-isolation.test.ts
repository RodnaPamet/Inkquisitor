/**
 * A multi-workspace job's per-workspace failure (Phase 4.H-a): logged with the
 * ids it was given and a code — never the error's message, which a third
 * party's error can fill with what it was handed — counted, and skipped.
 */
const mockError = jest.fn();
const mockSkipped = jest.fn();
jest.mock('@/lib/observability/logger', () => ({ logger: { error: (...a: unknown[]) => mockError(...a) } }));
jest.mock('@/lib/observability/metrics', () => ({ recordJobWorkspaceSkipped: (...a: unknown[]) => mockSkipped(...a) }));

import { servedWorkspace, workspaceFailureCode } from '@/app-layer/jobs/workspace-isolation';
import { WorkspaceKeyUnavailableError } from '@/lib/security/workspace-key-manager';

beforeEach(() => {
    mockError.mockReset();
    mockSkipped.mockReset();
});

it('returns the part’s value when it succeeds, logging and counting nothing', async () => {
    expect(await servedWorkspace('a-job', { workspaceId: 'ws1' }, async () => 7)).toBe(7);
    expect(mockError).not.toHaveBeenCalled();
    expect(mockSkipped).not.toHaveBeenCalled();
});

it('a key that cannot be unwrapped: null, logged and counted as WORKSPACE_KEY_UNAVAILABLE', async () => {
    const r = await servedWorkspace('a-job', { workspaceId: 'ws1', bookId: 'b1' }, async () => {
        throw new WorkspaceKeyUnavailableError('ws1', 'UNWRAP_FAILED');
    });
    expect(r).toBeNull();
    expect(mockError).toHaveBeenCalledWith('job.workspace_skipped', { component: 'jobs', job: 'a-job', workspaceId: 'ws1', bookId: 'b1', code: 'WORKSPACE_KEY_UNAVAILABLE' });
    expect(mockSkipped).toHaveBeenCalledWith({ jobName: 'a-job', code: 'WORKSPACE_KEY_UNAVAILABLE' });
});

it('any other failure: its name or code, never its message', async () => {
    const marker = 'Wren never learned to swim';
    const r = await servedWorkspace('a-job', { workspaceId: 'ws2' }, async () => {
        throw Object.assign(new Error(`Invalid invocation { data: { text: "${marker}" } }`), { name: 'PrismaClientKnownRequestError', code: 'P2034' });
    });
    expect(r).toBeNull();
    expect(JSON.stringify(mockError.mock.calls)).not.toContain(marker);
    expect(mockError.mock.calls[0][1]).toMatchObject({ code: 'P2034' });
    expect(workspaceFailureCode(new TypeError(marker))).toBe('TypeError');
    expect(workspaceFailureCode('a thrown string')).toBe('UnknownError');
});
