/**
 * A FAKE WEB for the research agent's tests (Phase 2.6): one gather turn
 * streamed as the Messages API streams the server tools' own blocks — a
 * `server_tool_use` for each search and fetch and its result block — for the
 * fake Messages API (`fake-anthropic.ts`, the `events` turn). No network.
 */
export interface FakePage {
    url: string;
    title: string;
    text: string;
}

/** The SSE events of one gather turn: a search for `query` finding `pages`, each page fetched, then `stop`. */
export function gatherEvents(opts: { query: string; pages: readonly FakePage[]; stop?: 'end_turn' | 'pause_turn'; fetchUrls?: readonly string[]; idBase?: string; pdfUrls?: readonly string[] }): Array<Record<string, unknown>> {
    const id = opts.idBase ?? 'a';
    const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { id: `msg_gather_${id}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1_500, output_tokens: 1 } } },
    ];
    let index = 0;
    const block = (start: Record<string, unknown>, delta?: Record<string, unknown>) => {
        events.push({ type: 'content_block_start', index, content_block: start });
        if (delta) events.push({ type: 'content_block_delta', index, delta });
        events.push({ type: 'content_block_stop', index });
        index += 1;
    };
    block({ type: 'server_tool_use', id: `srvtoolu_${id}_s`, name: 'web_search', input: {} }, { type: 'input_json_delta', partial_json: JSON.stringify({ query: opts.query }) });
    block({ type: 'web_search_tool_result', tool_use_id: `srvtoolu_${id}_s`, content: opts.pages.map((p) => ({ type: 'web_search_result', url: p.url, title: p.title, encrypted_content: 'enc', page_age: null })) });
    const fetchUrls = opts.fetchUrls ?? opts.pages.map((p) => p.url);
    fetchUrls.forEach((url, i) => {
        const page = opts.pages.find((p) => p.url === url);
        block({ type: 'server_tool_use', id: `srvtoolu_${id}_f${i}`, name: 'web_fetch', input: {} }, { type: 'input_json_delta', partial_json: JSON.stringify({ url }) });
        block({
            type: 'web_fetch_tool_result',
            tool_use_id: `srvtoolu_${id}_f${i}`,
            content: page
                ? { type: 'web_fetch_result', url, retrieved_at: '2026-11-20T10:00:00Z', content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: page.text }, title: page.title, citations: null } }
                : { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' },
        });
    });
    // A fetched PDF: a document whose source is base64, not text (issue #41 item 1).
    (opts.pdfUrls ?? []).forEach((url, i) => {
        block({ type: 'server_tool_use', id: `srvtoolu_${id}_p${i}`, name: 'web_fetch', input: {} }, { type: 'input_json_delta', partial_json: JSON.stringify({ url }) });
        block({
            type: 'web_fetch_tool_result',
            tool_use_id: `srvtoolu_${id}_p${i}`,
            content: { type: 'web_fetch_result', url, retrieved_at: '2026-11-20T10:00:00Z', content: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQK' }, title: 'A report', citations: null } },
        });
    });
    block({ type: 'text', text: '' }, { type: 'text_delta', text: 'Read the pages.' });
    events.push({
        type: 'message_delta',
        delta: { stop_reason: opts.stop ?? 'end_turn', stop_sequence: null },
        usage: { output_tokens: 80, server_tool_use: { web_search_requests: 1, web_fetch_requests: fetchUrls.length + (opts.pdfUrls?.length ?? 0) } },
    });
    events.push({ type: 'message_stop' });
    return events;
}

