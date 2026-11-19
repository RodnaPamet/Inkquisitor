/**
 * PDF document types (Phase 1.3).
 *
 * Adapted from inflect-compliance's `src/lib/pdf/types.ts` (see
 * docs/carve-manifest.md): `ReportMeta` kept with the workspace in place of
 * the tenant; the report-type enum, watermark, framework, content hash and
 * the table and summary types (compliance reports) are not carried.
 */
export interface ReportMeta {
    /** The workspace the document comes from. */
    workspaceName: string;
    reportTitle: string;
    reportSubtitle?: string;
    /** ISO timestamp the document was generated at. */
    generatedAt: string;
}
