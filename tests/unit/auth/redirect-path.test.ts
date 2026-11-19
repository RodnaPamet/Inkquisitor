/** A sign-in may only send the browser to a path on this site. */
import { postSignInPath, sanitizeRedirectPath } from '@/lib/auth/redirect-path';

it.each([
    ['/w/ada/books', '/w/ada/books'],
    ['/w/ada/settings?tab=sessions#x', '/w/ada/settings?tab=sessions#x'],
    ['%2Fw%2Fada%2Fbooks', '/w/ada/books'],
])('keeps a path on this site: %s', (input, expected) => {
    expect(sanitizeRedirectPath(input)).toBe(expected);
});

it.each([
    'https://evil.example/',
    '//evil.example/',
    '/\\evil.example',
    '/\tevil.example',
    '%2F%2Fevil.example',
    'javascript:alert(1)',
    'w/ada',
    '/x?u=https://evil.example',
    '%E0%A4%A',
    '',
])('refuses %j, falling back to /', (input) => {
    expect(sanitizeRedirectPath(input)).toBe('/');
});

it('postSignInPath falls back to /, which sends a signed-in person to their workspace', () => {
    expect(postSignInPath(null)).toBe('/');
    expect(postSignInPath('/w/ada')).toBe('/w/ada');
});
