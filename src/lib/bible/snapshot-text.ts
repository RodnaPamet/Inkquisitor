/**
 * A version snapshot as readable lines for `<VersionDiff>` (Phase 1.2, the
 * History tab): the element's name, status and summary, then every filled
 * field under its template label, in template order, with a choice shown by
 * its option's label and a scale by its position. Never the raw JSON.
 *
 * The result is HTML handed to `<VersionDiff contentType="HTML">`, whose
 * `htmlToLines` strips every tag (block ends become line breaks) before the
 * diff runs, and React renders the lines as TEXT. Plain values are escaped
 * here, so an author's literal `<` stays a character; a rich-text value is
 * the sanitised HTML the API stored, reduced to its text lines
 * (`htmlToLines`) and escaped like any other text.
 *
 * A field the snapshot holds but the kind's current template no longer has is
 * shown last, under its key, so a diff never hides what a version contained.
 *
 * Client-safe: its one value import is `htmlToLines`, the strip
 * `<VersionDiff>` itself runs.
 */
import { htmlToLines } from '@/components/ui/VersionDiff';
import type { BibleSnapshot } from './snapshot';
import type { FieldDef } from './template-schema';

export interface SnapshotTextLabels {
    name: string;
    customLabel: string;
    status: string;
    summary: string;
    /** The status enum value, worded. */
    statusValue: (status: string) => string;
    /** A scale value, worded (e.g. "4 of 5"). */
    scaleValue: (value: number) => string;
}

export function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const line = (s: string) => `<p>${escapeHtml(s)}</p>`;
const paragraphs = (s: string) =>
    s
        .split(/\n+/)
        .filter((p) => p.trim() !== '')
        .map(line)
        .join('');

function valueText(def: FieldDef | undefined, value: unknown, labels: SnapshotTextLabels): string {
    if (def?.type === 'choice' && typeof value === 'string') return def.options.find((o) => o.value === value)?.label ?? value;
    if (def?.type === 'scale' && typeof value === 'number') return labels.scaleValue(value);
    return String(value);
}

export function snapshotToDiffHtml(snapshot: BibleSnapshot, fields: readonly FieldDef[], labels: SnapshotTextLabels): string {
    const { element } = snapshot;
    const out: string[] = [line(`${labels.name}: ${element.name}`)];
    if (element.customLabel) out.push(line(`${labels.customLabel}: ${element.customLabel}`));
    out.push(line(`${labels.status}: ${labels.statusValue(element.status)}`));
    if (element.summary) out.push(line(`${labels.summary}:`), paragraphs(element.summary));

    const byKey = new Map(snapshot.fields.map((f) => [f.key, f.value] as const));
    const render = (title: string, def: FieldDef | undefined, value: unknown) => {
        if (Array.isArray(value)) {
            out.push(line(`${title}:`), ...value.map((item) => line(`• ${item}`)));
        } else if (def?.type === 'richtext' && typeof value === 'string') {
            // Sanitised HTML from the API, reduced to its text lines here, each
            // a line of its own: inserted as it is, a value that does not end
            // in a block (bare inline text, which the API accepts) ran into
            // the next field's line.
            out.push(line(`${title}:`), paragraphs(htmlToLines(value)));
        } else {
            out.push(line(`${title}: ${valueText(def, value, labels)}`));
        }
    };
    for (const def of fields) {
        if (byKey.has(def.key)) render(def.label, def, byKey.get(def.key));
    }
    const known = new Set(fields.map((f) => f.key));
    for (const f of snapshot.fields) {
        if (!known.has(f.key)) render(f.key, undefined, f.value);
    }
    return out.join('');
}
