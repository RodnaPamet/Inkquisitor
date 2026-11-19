import { redirect } from 'next/navigation';

/** A workspace's root opens its Books page. */
export default async function WorkspaceHome({ params }: { params: Promise<{ workspaceSlug: string }> }) {
    const { workspaceSlug } = await params;
    redirect(`/w/${encodeURIComponent(workspaceSlug)}/books`);
}
