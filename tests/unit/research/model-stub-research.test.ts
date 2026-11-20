/**
 * The loopback stub answers the research agent (Phase 2.6, D13): a fake web
 * with no network, deterministic findings that quote it, a fit into the scope.
 */
import { stubFindingsAnswer, stubFitAnswer, stubMessagesFetch, stubWebPage, STUB_WEB_ORIGIN } from '@/lib/ai/model-stub';
import { parseFindingsOutput } from '@/lib/research/schema';
import { validateFindings } from '@/lib/research/validate';

const fence = '0'.repeat(32);
const body = (blocks: Array<[string, string]>, extra: Record<string, unknown> = {}) => ({
    model: 'claude-sonnet-5-5',
    messages: [{ role: 'user', content: blocks.map(([l, t]) => `<author_data_${fence} label="${l}">\n${t}\n</author_data_${fence}>`).join('\n') }],
    ...extra,
});

it('a gather request gets one search and one fetch of a page built from the question, under a reserved .example name', async () => {
    const res = await stubMessagesFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify(body([['brief.question', 'How did falconers train hawks?']], { tools: [{ type: 'web_search_20260209', name: 'web_search' }] })),
    });
    const text = await res.text();
    const page = stubWebPage('How did falconers train hawks?');
    expect(page.url.startsWith(`${STUB_WEB_ORIGIN}/`)).toBe(true);
    expect(text).toContain('"name":"web_search"');
    expect(text).toContain('web_fetch_tool_result');
    expect(text).toContain('web_search_requests');
});

it('its findings quote each source verbatim and pass the product’s own check; its fit adds into the first empty field', () => {
    const page = stubWebPage('How did falconers train hawks?');
    const src = { ref: 'web.1', kind: 'URL' as const, url: page.url, sourceId: null, title: page.title, text: page.text, retrievedAt: null };
    const answer = stubFindingsAnswer(body([['source.web.1', JSON.stringify(src)]]));
    expect(validateFindings(parseFindingsOutput(answer), [src], 6).findings).toHaveLength(1);
    const fit = stubFitAnswer(
        body([
            ['finding.f1', JSON.stringify({ ref: 'f1', claim: 'A claim.' })],
            ['element.1', JSON.stringify({ elementId: 'el-1', role: 'scope', fields: [{ key: 'role', type: 'text' }, { key: 'want', type: 'text' }], stored_values: { role: 'x' } })],
        ]),
    );
    expect(fit?.proposals[0]).toMatchObject({ op: 'ADD', elementId: 'el-1', fieldKey: 'want', cites: ['f1'] });
});
