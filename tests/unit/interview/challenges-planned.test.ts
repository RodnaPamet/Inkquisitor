/**
 * The per-session challenge limit counts challenges of rounds that were asked,
 * never those planned by a FAILED round (issue #32, item 6): a provider outage
 * or a cancelled stream must not use the limit up.
 */
import { challengesPlannedOf } from '@/app-layer/usecases/interview-state';

const round = (status: 'OPEN' | 'CLOSED' | 'FAILED' | 'GENERATING', challenge: boolean) => ({ status, plan: { challenge: challenge ? { elementId: 'e', fieldKey: 'role' } : null } });

it('counts the challenges of asked and in-flight rounds, not of failed ones', () => {
    expect(challengesPlannedOf([round('FAILED', true), round('FAILED', true)])).toBe(0);
    expect(challengesPlannedOf([round('CLOSED', true), round('FAILED', true), round('OPEN', true), round('GENERATING', true), round('CLOSED', false)])).toBe(3);
    expect(challengesPlannedOf([])).toBe(0);
});
