/**
 * The binding util for story edges.
 *
 * Carved from inflect-compliance's `ProcessEdgeBindingUtil.ts`
 * (docs/carve-manifest.md). Deliberately thin: the edge's meaning lives in
 * `story-edge-binding.ts` (props and validators) and `edge-validation.ts`
 * (whether it may exist), which are testable without an editor.
 *
 * No `onBeforeCreate` refusal, on purpose: a vetoed create would make the
 * refusal invisible. The arrow converter refuses where it can say why.
 */
import { BindingUtil, type BindingOnShapeChangeOptions, type BindingOnShapeDeleteOptions, type TLShapeId } from 'tldraw';

import { STORY_EDGE_SHAPE_TYPE, edgeLineGeometry, shapeIdForRelation } from './story-edge-shape';
import { STORY_EDGE_BINDING_TYPE, storyEdgeBindingProps, type StoryEdgeBinding } from './story-edge-binding';

export class StoryEdgeBindingUtil extends BindingUtil<StoryEdgeBinding> {
    static override type = STORY_EDGE_BINDING_TYPE;
    static override props = storyEdgeBindingProps;

    override getDefaultProps(): Partial<StoryEdgeBinding['props']> {
        // An edge is only ever created naming its relation (the converter and
        // the load path); empty values here are refused by the serializer.
        return { relationId: '', sourceElementId: '', targetElementId: '' };
    }

    /**
     * Keep the drawn line attached when either endpoint moves. Each hook moves
     * ONE line (these fire continuously through a drag).
     */
    override onAfterChangeFromShape({ binding }: BindingOnShapeChangeOptions<StoryEdgeBinding>): void {
        this.repositionLine(binding);
    }

    override onAfterChangeToShape({ binding }: BindingOnShapeChangeOptions<StoryEdgeBinding>): void {
        this.repositionLine(binding);
    }

    /** Remove the line when an endpoint goes: tldraw deletes the binding, not the third record. */
    override onBeforeDeleteFromShape({ binding }: BindingOnShapeDeleteOptions<StoryEdgeBinding>): void {
        this.deleteLine(binding);
    }

    override onBeforeDeleteToShape({ binding }: BindingOnShapeDeleteOptions<StoryEdgeBinding>): void {
        this.deleteLine(binding);
    }

    private repositionLine(binding: StoryEdgeBinding): void {
        const lineId = shapeIdForRelation(binding.props.relationId);
        // No line yet is the normal case during seeding.
        if (!this.editor.getShape(lineId)) return;
        const from = this.editor.getShapePageBounds(binding.fromId as TLShapeId);
        const to = this.editor.getShapePageBounds(binding.toId as TLShapeId);
        if (!from || !to) return;
        const g = edgeLineGeometry(from, to);
        this.editor.updateShape({ id: lineId, type: STORY_EDGE_SHAPE_TYPE, x: g.x, y: g.y, props: { dx: g.dx, dy: g.dy } });
    }

    private deleteLine(binding: StoryEdgeBinding): void {
        const lineId = shapeIdForRelation(binding.props.relationId);
        if (this.editor.getShape(lineId)) this.editor.deleteShapes([lineId]);
    }
}
