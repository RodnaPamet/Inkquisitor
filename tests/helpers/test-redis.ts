/**
 * The Redis an integration test uses: `REDIS_URL` from the shell (CI's Test
 * job exports its service), else the local compose Redis, always on logical
 * database 14 so a test never touches the database the dev server or the
 * worker uses. A suite that writes keys also names its queue uniquely.
 */
export function testRedisUrl(): string {
    const url = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
    url.pathname = '/14';
    return url.toString();
}
