/**
 * Skeleton loading primitives.
 *
 * No inflect-compliance suite exists for these, so this one is new. A
 * skeleton is decoration that stands in for content still loading: every
 * block is hidden from assistive technology, the composed skeletons say the
 * region is busy, and the count props decide how many rows or lines appear.
 */
import { render } from '@testing-library/react';
import * as React from 'react';
import {
    Skeleton,
    SkeletonCard,
    SkeletonDataTable,
    SkeletonDetailPage,
    SkeletonKpiGrid,
    SkeletonLine,
} from '@/components/ui/skeleton';

describe('skeleton primitives', () => {
    it('a block is aria-hidden and merges the caller className', () => {
        const { container } = render(<Skeleton className="h-4 w-24" />);
        const block = container.firstElementChild!;
        expect(block).toHaveAttribute('aria-hidden', 'true');
        expect(block).toHaveClass('h-4', 'w-24', 'bg-bg-subtle');
    });

    it('a line is a block with the body-text height', () => {
        const { container } = render(<SkeletonLine className="w-1/2" />);
        expect(container.firstElementChild).toHaveClass('h-4', 'w-1/2');
        expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    });

    it('a card renders the requested number of lines', () => {
        const count = (lines: number) => {
            const { container, unmount } = render(<SkeletonCard lines={lines} />);
            const n = container.querySelectorAll('.h-4').length;
            unmount();
            return n;
        };
        expect(count(5) - count(2)).toBe(3);
    });

    it('a data table renders one skeleton row per requested row', () => {
        const rows = (n: number) => {
            const { container, unmount } = render(<SkeletonDataTable rows={n} cols={3} />);
            const count = container.querySelectorAll('tbody tr, [data-skeleton-row]').length;
            unmount();
            return count;
        };
        expect(rows(6) - rows(2)).toBe(4);
    });

    it('a KPI grid renders `count` cards', () => {
        const { container } = render(<SkeletonKpiGrid count={3} />);
        expect(container.firstElementChild!.children).toHaveLength(3);
    });

    it('composed page skeletons mark themselves busy and expose no text', () => {
        const { container } = render(<SkeletonDetailPage />);
        expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
        expect(container.textContent).toBe('');
    });
});
