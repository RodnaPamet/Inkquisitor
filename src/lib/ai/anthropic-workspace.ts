/**
 * THE ANTHROPIC WORKSPACE HEADER — one definition for every caller of the
 * Anthropic API.
 *
 * An API key created inside a workspace carries its workspace with it. An
 * ORGANISATION-level key does not, and Anthropic refuses its requests with
 * HTTP 400 — "This API key is not scoped to a workspace, so this request must
 * include the anthropic-workspace-id header with the ID of the workspace" —
 * unless each request names the workspace it belongs to.
 *
 * Lifted from inflect-compliance's `src/lib/ai/anthropic-workspace.ts` (see
 * docs/carve-manifest.md; Phase 2.3, for the `Evals` workflow's key).
 *
 * `ANTHROPIC_WORKSPACE_ID` (`src/env.ts`) is that name. When it is set (and well formed), every
 * request to the Anthropic API carries `anthropic-workspace-id: <id>`. When it
 * is unset this returns an EMPTY object, so a caller that spreads it sends
 * exactly the headers it sent before and a workspace-scoped key keeps working
 * untouched.
 *
 * ── WHY THE ID IS AN ARGUMENT, NOT READ FROM `env` HERE ─────────────────────
 *
 * `clientForRun` (`./client.ts`, the one place a client is built) resolves the
 * key at its construction site and passes the id with it, so this module
 * imports nothing and can be tested alone.
 *
 * ── WHY IT TRIMS ────────────────────────────────────────────────────────────
 *
 * The schema in `src/env.ts` trims too, but only when it runs: under
 * `SKIP_ENV_VALIDATION=1` (the image build, every Jest run) `@t3-oss/env-nextjs`
 * hands back the raw string unparsed. Trimming at the one place every caller
 * passes through means a trailing newline pasted into an env file cannot become
 * a header value `fetch` refuses, whichever path the value took to get here. A
 * blank or whitespace-only value is treated as unset, which is what an operator
 * who cleared it meant.
 *
 * ── WHY IT IS CHECKED ───────────────────────────────────────────────────────
 *
 * The value becomes a request header on every call. An Anthropic workspace id
 * is a short token (`wrkspc_…`); anything else — a space, a comma, a quote, a
 * control character, a pasted second header — is a configuration mistake, and
 * the header is never sent with it (an empty object, as when unset: an
 * organisation-level key is then refused by Anthropic, loudly). Production
 * refuses to start with a malformed value (`aiConfigProblems`), and the env
 * schema refuses it where validation runs.
 */

/** What an Anthropic workspace id may look like: letters, digits, `_` and `-`, at most 128. */
export const ANTHROPIC_WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Is `value`, trimmed, an acceptable workspace id? */
export function isAnthropicWorkspaceId(value: string): boolean {
    return ANTHROPIC_WORKSPACE_ID_PATTERN.test(value.trim());
}

/** The request header Anthropic reads to place an organisation-level key's request in a workspace. */
export const ANTHROPIC_WORKSPACE_HEADER = 'anthropic-workspace-id';

/**
 * The extra headers a request to the Anthropic API needs for this workspace
 * id: `{ 'anthropic-workspace-id': id }` when one is configured, `{}` when not.
 */
export function anthropicWorkspaceHeaders(
    workspaceId: string | null | undefined,
): Record<string, string> {
    const id = workspaceId?.trim();
    return id && isAnthropicWorkspaceId(id) ? { [ANTHROPIC_WORKSPACE_HEADER]: id } : {};
}
