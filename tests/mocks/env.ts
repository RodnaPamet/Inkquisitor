// Mocks BOTH src/env.ts and src/env-client.ts (mapped from both specifiers in
// jest.config.js) to bypass @t3-oss/env-nextjs, which ships ESM only.
//
// A Proxy answers every key from process.env, so a test overrides a variable
// by setting process.env before it reads it. The defaults below mirror the
// real schema's defaults; a mock that answers differently from production
// would turn its suites green without testing the shipped configuration.
const DEFAULTS: Record<string, string> = {
    // src/env.ts defaults NODE_ENV to 'development'. Jest exports
    // NODE_ENV=test, so process.env answers first in practice.
    NODE_ENV: 'development',
    // src/env.ts: one trusted proxy (Caddy) unless configured.
    TRUSTED_PROXY_HOPS: '1',
};

const handler: ProxyHandler<Record<string, string | undefined>> = {
    get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        return process.env[prop] ?? DEFAULTS[prop];
    },
};

export const env = new Proxy<Record<string, string | undefined>>({}, handler);
export const envClient = env;
