/**
 * The DataTable's hidden batch-action toolbar is INERT.
 *
 * `<DataTable>` mounts `<SelectionToolbar>` by default and hides it with
 * opacity while nothing is selected. Hidden by opacity alone, its select-all
 * checkbox and batch buttons stayed in the tab order and the accessibility
 * tree. `inert` is what removes them, and under React 19 it is a BOOLEAN
 * prop: the empty string the lifted code passed (a React 18 workaround) read
 * as false, so React dropped the attribute and warned. This suite holds the
 * attribute present while hidden, absent once a row is selected, and the
 * render free of React's boolean-attribute warning.
 */
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn() }),
    usePathname: () => '/x',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({}),
}));

import { DataTable, createColumns } from '@/components/ui/table';

interface RowT {
    id: string;
    name: string;
}
const data: RowT[] = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Bravo' },
];
const columns = createColumns<RowT>([
    { id: 'name', header: 'Name', accessorFn: (r) => r.name, cell: ({ getValue }) => <span>{getValue<string>()}</span> },
]);

describe('<SelectionToolbar> inside <DataTable>', () => {
    it('is inert while nothing is selected, and not once a row is', () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const { container } = render(<DataTable<RowT> data={data} columns={columns} getRowId={(r) => r.id} />);
            const toolbar = screen.getByRole('toolbar', { name: 'Batch actions', hidden: true });
            expect(toolbar).toHaveAttribute('inert');

            const firstRow = container.querySelectorAll('tbody tr')[0] as HTMLElement;
            fireEvent.click(firstRow.querySelector('[title="Select"]') as HTMLElement);
            expect(toolbar).not.toHaveAttribute('inert');

            const inertWarnings = error.mock.calls.filter((args) => args.some((a) => String(a).includes('inert')));
            expect(inertWarnings).toEqual([]);
        } finally {
            error.mockRestore();
        }
    });
});
