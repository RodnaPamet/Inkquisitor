/**
 * A scene's text as stored (Phase 5.1): the prose profile, mentions kept only for ids the caller vouches for, words
 * counted the way the editor counts them, an import's paragraphs escaped (imported text never becomes markup), the
 * plain-text bounds of titles, story time and notes, and the import token.
 */
import { countSceneWords, mentionCandidates, mentionIdsOf, paragraphsAsHtml, storableSceneHtml } from '@/lib/manuscript/scene-html';
import { countWords, sessionProgress } from '@/lib/manuscript/word-count';
import { ManuscriptTextTooLongError, sanitiseManuscriptTitle, sanitiseSceneNote, sanitiseStoryTime } from '@/lib/manuscript/storage';
import { fileSha256, signImportToken, verifyImportToken } from '@/lib/manuscript/import-token';
import { MANUSCRIPT_TITLE_MAX, SCENE_NOTE_MAX } from '@/lib/manuscript/vocabulary';

describe('the prose profile', () => {
    it('keeps prose and emphasis, drops headings, links, scripts and every attribute but a vouched mention', () => {
        const raw =
            '<h2>Gone</h2><p class="x" style="color:red">She <strong>ran</strong> <em>home</em>.</p><script>alert(1)</script>' +
            '<p><a href="https://evil.example">link</a> <img src=x onerror=alert(1)></p><blockquote>Quoted</blockquote><hr>' +
            '<p><span data-mention="abc123" onclick="x()">@Wren</span> <span data-mention="zzz999">@Other</span> <span data-mention="BAD id">@Bad</span></p>';
        const stored = storableSceneHtml(raw, (id) => id === 'abc123');
        expect(stored).toBe(
            'Gone<p>She <strong>ran</strong> <em>home</em>.</p><p>link </p><blockquote>Quoted</blockquote><hr /><p><span data-mention="abc123">@Wren</span> <span>@Other</span> <span>@Bad</span></p>',
        );
        expect(mentionIdsOf(stored)).toEqual(['abc123']);
        expect(mentionCandidates(raw)).toEqual(['abc123', 'zzz999', 'BAD id']);
    });

    it('leaves no control character a text column refuses, decoded or raw', () => {
        const stored = storableSceneHtml('<p>A&#0;B\u0007C\u0000D</p>', () => true);
        expect(stored).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
        expect(stored.startsWith('<p>A')).toBe(true);
        expect(stored.endsWith('BCD</p>')).toBe(true);
    });

    it('counts words as the editor does, a break between blocks', () => {
        expect(countSceneWords('<p>Don\'t stop.</p><p>Well-known end</p>')).toBe(countWords("Don't stop.\nWell-known end"));
        expect(countSceneWords('<p>one</p><p>two</p>')).toBe(2);
        expect(countSceneWords('')).toBe(0);
        expect(countWords('   ')).toBe(0);
    });

    it('escapes an import\'s paragraphs so imported text never becomes markup', () => {
        const html = paragraphsAsHtml(['<script>alert(1)</script> & "quotes"', '', 'Second']);
        expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;</p><p>Second</p>');
        expect(storableSceneHtml(html, () => false)).toContain('&lt;script&gt;');
    });
});

describe('plain author text', () => {
    it('sanitises titles, story times and notes, blank as cleared, past the bound refused by name', () => {
        expect(sanitiseManuscriptTitle('<b>Arrival</b>  at dawn')).toBe('Arrival at dawn');
        expect(sanitiseManuscriptTitle('   ')).toBeNull();
        expect(sanitiseStoryTime('Day <i>2</i>')).toBe('Day 2');
        expect(sanitiseSceneNote('One\n\n\n\nTwo')).toBe('One\n\nTwo');
        expect(() => sanitiseManuscriptTitle('x'.repeat(MANUSCRIPT_TITLE_MAX + 1))).toThrow(ManuscriptTextTooLongError);
        expect(() => sanitiseSceneNote('x'.repeat(SCENE_NOTE_MAX + 1))).toThrow(ManuscriptTextTooLongError);
    });

    it('measures a session as net words added, never below zero', () => {
        expect(sessionProgress(100, 250)).toBe(150);
        expect(sessionProgress(100, 40)).toBe(0);
    });
});

describe('the import token', () => {
    const claims = { workspaceId: 'ws-1', userId: 'u-1', bookId: 'b-1', fileSha256: fileSha256(new TextEncoder().encode('# Chapter')), issuedAt: 1_000_000 };

    it('binds the reader, the book and the very file, for an hour', () => {
        const token = signImportToken(claims);
        expect(verifyImportToken(claims, token, 1_000_000)).toBe('OK');
        expect(verifyImportToken({ ...claims, fileSha256: fileSha256(new TextEncoder().encode('# Changed')) }, token, 1_000_000)).toBe('BAD_TOKEN');
        expect(verifyImportToken({ ...claims, bookId: 'b-2' }, token, 1_000_000)).toBe('BAD_TOKEN');
        expect(verifyImportToken({ ...claims, workspaceId: 'ws-2' }, token, 1_000_000)).toBe('BAD_TOKEN');
        expect(verifyImportToken(claims, token, 1_000_000 + 61 * 60_000)).toBe('EXPIRED');
    });
});
