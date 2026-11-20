/**
 * Draws a story edge, and makes it selectable.
 *
 * Carved from inflect-compliance's `ProcessEdgeShapeUtil.tsx`
 * (docs/carve-manifest.md), without the process variants and automation
 * chips. See `story-edge-shape.ts` for why an edge needs both a binding and
 * a shape. RESIZE and BIND are refused: `dx` / `dy` are derived and not
 * persisted, and an edge is not an endpoint (a MapEdge joins two elements).
 */
import { Edge2d, HTMLContainer, ShapeUtil, Vec } from 'tldraw';

import { STORY_EDGE_SHAPE_TYPE, storyEdgeShapeProps, type StoryEdgeShape } from './story-edge-shape';

/** Stroke width in page units. */
const EDGE_STROKE = 2;

export class StoryEdgeShapeUtil extends ShapeUtil<StoryEdgeShape> {
    static override type = STORY_EDGE_SHAPE_TYPE;
    static override props = storyEdgeShapeProps;

    override getDefaultProps(): StoryEdgeShape['props'] {
        return { relationId: '', label: '', dx: 0, dy: 0 };
    }

    /** Hit-testing follows the line, not its bounding box. */
    override getGeometry(shape: StoryEdgeShape): Edge2d {
        return new Edge2d({ start: new Vec(0, 0), end: new Vec(shape.props.dx, shape.props.dy) });
    }

    override canBind(): boolean {
        return false;
    }

    override canResize(): boolean {
        return false;
    }

    override hideResizeHandles(): boolean {
        return true;
    }

    override hideRotateHandle(): boolean {
        return true;
    }

    /** A resize is refused (`canResize`); were one to arrive, nothing moves. */
    override onResize(shape: StoryEdgeShape): StoryEdgeShape {
        return shape;
    }

    override component(shape: StoryEdgeShape) {
        const { dx, dy, label } = shape.props;
        // A zero-size container with visible overflow: the line frequently
        // runs up or left, which a sized SVG would clip.
        return (
            <HTMLContainer id={shape.id} style={{ width: 0, height: 0 }}>
                <svg style={{ overflow: 'visible', position: 'absolute', pointerEvents: 'none' }} aria-hidden="true">
                    <line x1={0} y1={0} x2={dx} y2={dy} strokeWidth={EDGE_STROKE} className="stroke-border-emphasis" strokeLinecap="round" />
                </svg>
                {label !== '' && (
                    <div
                        data-story-edge-label={shape.props.relationId}
                        style={{ position: 'absolute', left: dx / 2, top: dy / 2, transform: 'translate(-50%, -50%)', maxWidth: 160, pointerEvents: 'none' }}
                        className="truncate rounded-[3px] bg-bg-default px-1 text-[10px] leading-4 text-content-muted"
                    >
                        {label}
                    </div>
                )}
            </HTMLContainer>
        );
    }

    override indicator(shape: StoryEdgeShape) {
        const { dx, dy } = shape.props;
        return <line x1={0} y1={0} x2={dx} y2={dy} strokeWidth={EDGE_STROKE + 2} />;
    }
}
