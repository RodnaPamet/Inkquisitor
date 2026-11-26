/**
 * Metrics — OpenTelemetry counters and histograms.
 *
 *   api.request.count      Counter   (http.method, http.route, http.status_code)
 *   api.request.duration   Histogram (same) [ms]
 *   api.request.errors     Counter   (http.method, http.route, error.code)
 *   job.execution.count    Counter   (job.name, job.status)
 *   job.execution.duration Histogram (job.name, job.status) [ms]
 *   job.workspace.skipped  Counter   (job.name, error.code): one workspace a
 *                          multi-workspace job could not serve (4.H-a)
 *
 * Instruments are created lazily so the global MeterProvider can be installed
 * first; before `initTelemetry()` they are the API's no-op instruments.
 *
 * Cardinality: routes are normalised (`normalizeRoute`) so ids do not become
 * labels, and workspace and user ids are never labels — they are span
 * attributes, searchable in traces without exploding a metric series.
 *
 * Cut down from inflect-compliance's `src/lib/observability/metrics.ts`: the
 * request and job instruments only.
 */

import { metrics, type Counter, type Histogram } from '@opentelemetry/api';

const METER_NAME = 'inkquisitor';
const getMeter = () => metrics.getMeter(METER_NAME);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const OPAQUE_ID_RE = /\/[a-z0-9]{20,}\b/gi;

/**
 * A pathname as a low-cardinality route label: UUIDs and long opaque ids
 * become `:id`, and a workspace slug in `/w/<slug>/` becomes `:workspaceSlug`.
 */
export function normalizeRoute(pathname: string): string {
    return pathname
        .replace(UUID_RE, ':id')
        .replace(/\/w\/([^/]+)(\/|$)/, '/w/:workspaceSlug$2')
        .replace(OPAQUE_ID_RE, '/:id');
}

let requestCount: Counter | null = null;
let requestDuration: Histogram | null = null;
let requestErrors: Counter | null = null;
let jobCount: Counter | null = null;
let jobDuration: Histogram | null = null;
let jobWorkspaceSkipped: Counter | null = null;

export function recordRequestMetrics(attrs: { method: string; route: string; status: number; durationMs: number }): void {
    requestCount ??= getMeter().createCounter('api.request.count', { description: 'API requests', unit: '1' });
    requestDuration ??= getMeter().createHistogram('api.request.duration', { description: 'API request duration', unit: 'ms' });
    const labels = {
        'http.method': attrs.method,
        'http.route': normalizeRoute(attrs.route),
        'http.status_code': attrs.status,
    };
    requestCount.add(1, labels);
    requestDuration.record(attrs.durationMs, labels);
}

export function recordRequestError(attrs: { method: string; route: string; errorCode: string }): void {
    requestErrors ??= getMeter().createCounter('api.request.errors', { description: 'API request errors', unit: '1' });
    requestErrors.add(1, {
        'http.method': attrs.method,
        'http.route': normalizeRoute(attrs.route),
        'error.code': attrs.errorCode,
    });
}

export function recordJobMetrics(attrs: { jobName: string; success: boolean; durationMs: number }): void {
    jobCount ??= getMeter().createCounter('job.execution.count', { description: 'Job executions', unit: '1' });
    jobDuration ??= getMeter().createHistogram('job.execution.duration', { description: 'Job duration', unit: 'ms' });
    const labels = { 'job.name': attrs.jobName, 'job.status': attrs.success ? 'success' : 'failure' };
    jobCount.add(1, labels);
    jobDuration.record(attrs.durationMs, labels);
}

/**
 * A job that serves many workspaces (a dispatcher) skipped one it could not
 * serve, and went on with the rest (4.H-a). The workspace id is a log field,
 * never a label (cardinality, above).
 */
export function recordJobWorkspaceSkipped(attrs: { jobName: string; code: string }): void {
    jobWorkspaceSkipped ??= getMeter().createCounter('job.workspace.skipped', { description: 'Workspaces a multi-workspace job skipped', unit: '1' });
    jobWorkspaceSkipped.add(1, { 'job.name': attrs.jobName, 'error.code': attrs.code });
}
