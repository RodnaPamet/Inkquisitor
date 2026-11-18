import { publicBaseUrl } from '@/lib/http/public-base-url';
import { contentDispositionHeader } from '@/lib/http/content-disposition';

const req = { nextUrl: new URL('http://0.0.0.0:3000/api/x') } as never;

afterEach(() => {
    delete process.env.APP_URL;
});

it('APP_URL wins over the request origin, trailing slashes trimmed', () => {
    process.env.APP_URL = 'https://app.inkquisitor.example/';
    expect(publicBaseUrl(req)).toBe('https://app.inkquisitor.example');
});

it('the request origin is only a fallback', () => {
    expect(publicBaseUrl(req)).toBe('http://0.0.0.0:3000');
});

it('a download filename cannot split the header or close the quoted string', () => {
    const header = contentDispositionHeader('bible"; x=1\r\nSet-Cookie: a=b.md');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.match(/"/g)).toHaveLength(2);
});
