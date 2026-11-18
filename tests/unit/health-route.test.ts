import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
    it('answers 200 with exactly { status: "ok" }', async () => {
        const res = GET();
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/^application\/json/);
        await expect(res.json()).resolves.toEqual({ status: 'ok' });
    });

    it('is never cached, so a probe always reaches the live process', () => {
        expect(GET().headers.get('cache-control')).toBe('no-store');
    });
});
