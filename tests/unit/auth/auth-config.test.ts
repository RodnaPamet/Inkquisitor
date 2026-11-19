/**
 * Small pieces of the auth configuration: the secret, which POSTs carry a
 * credential, the sign-in error mapping, the providers.
 */
import { authSecret, DEV_FALLBACK_AUTH_SECRET } from '@/lib/auth/auth-secret';
import { carriesCredential } from '@/lib/auth/credential-post';
import { signInErrorKey } from '@/components/auth/sign-in-errors';
import { slugify } from '@/app-layer/usecases/sign-up';

// NODE_ENV is typed read-only; tests flip it through a plain record.
const mutableEnv = process.env as Record<string, string | undefined>;

afterEach(() => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXT_PHASE;
    mutableEnv.NODE_ENV = 'test';
});

describe('authSecret', () => {
    it('reads AUTH_SECRET when set', () => {
        process.env.AUTH_SECRET = 'x'.repeat(40);
        expect(authSecret()).toBe('x'.repeat(40));
    });

    it('falls back to the documented development value outside production', () => {
        expect(authSecret()).toBe(DEV_FALLBACK_AUTH_SECRET);
    });

    it('throws in a running production process without it, but not during `next build`', () => {
        mutableEnv.NODE_ENV = 'production';
        expect(() => authSecret()).toThrow(/AUTH_SECRET is required/);
        process.env.NEXT_PHASE = 'phase-production-build';
        expect(authSecret()).toBe(DEV_FALLBACK_AUTH_SECRET);
    });
});

it('carriesCredential: the credentials callback and the sign-in starts, in any case', () => {
    expect(carriesCredential(['callback', 'credentials'])).toBe(true);
    expect(carriesCredential(['CALLBACK', 'Credentials'])).toBe(true);
    expect(carriesCredential(['signin', 'google'])).toBe(true);
    expect(carriesCredential(['signout'])).toBe(false);
    expect(carriesCredential(['session'])).toBe(false);
    expect(carriesCredential(['callback', 'google'])).toBe(false);
    expect(carriesCredential(undefined)).toBe(false);
});

it('signInErrorKey never distinguishes an unknown email from a wrong password', () => {
    expect(signInErrorKey('CredentialsSignin')).toBe('invalid');
    expect(signInErrorKey('RateLimited')).toBe('rateLimited');
    expect(signInErrorKey('GoogleEmailUnverified')).toBe('googleUnverified');
    expect(signInErrorKey('OAuthCallback')).toBe('generic');
    expect(signInErrorKey(null)).toBeNull();
});

it('slugify makes a URL-safe slug from free text', () => {
    expect(slugify("Ada's Quill Works")).toBe('ada-s-quill-works');
    expect(slugify('Ünïcödé  Désk')).toBe('unicode-desk');
    expect(slugify('!!!')).toBe('workspace');
    expect(slugify('x'.repeat(100))).toHaveLength(40);
    expect(slugify('a-'.repeat(30))).not.toMatch(/-$/);
});

describe('providers', () => {
    function loadAuthOptions() {
        let options: typeof import('@/auth').authOptions | undefined;
        jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh module per env
            options = (require('@/auth') as typeof import('@/auth')).authOptions;
        });
        return options!;
    }

    afterEach(() => {
        delete process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_SECRET;
    });

    it('Credentials only, unless both Google variables are set', () => {
        expect(loadAuthOptions().providers.map((p) => p.id)).toEqual(['credentials']);
        process.env.GOOGLE_CLIENT_ID = 'client.apps.example';
        expect(loadAuthOptions().providers.map((p) => p.id)).toEqual(['credentials']);
        process.env.GOOGLE_CLIENT_SECRET = ['not', 'a', 'secret'].join('-');
        expect(loadAuthOptions().providers.map((p) => p.id)).toEqual(['credentials', 'google']);
    });

    it('sessions are JWTs that live as long as their session row', () => {
        const options = loadAuthOptions();
        expect(options.session).toEqual({ strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 });
        expect(options.pages).toEqual({ signIn: '/login', error: '/login' });
    });
});
