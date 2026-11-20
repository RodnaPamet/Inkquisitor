/**
 * Draws a bible element on a story map: its name, its kind and its
 * completeness badge.
 *
 * Carved from inflect-compliance's `ProcessNodeShapeUtil.tsx`
 * (docs/carve-manifest.md), with the twelve-kind process taxonomy, the run
 * overlays, the rule status, the checkpoint review and the group fold all
 * gone: one card per element.
 *
 * RESIZE IS SAVED here — the MapNode row has `w` and `h`, and the serializer
 * reads them — so `canResize` is true (inflect's node locked it because its
 * row had nowhere to keep a size). Rotation is hidden: it has no column.
 *
 * Every string shown comes from the shape's props, resolved by the host: a
 * shape util has no translator.
 */
import { HTMLContainer, Rectangle2d, ShapeUtil, resizeBox, type TLResizeInfo } from 'tldraw';

import { NODE_MAX_SIZE, NODE_MIN_SIZE } from '@/lib/canvas/limits';
import { NODE_DEFAULT_H, NODE_DEFAULT_W, STORY_NODE_SHAPE_TYPE, storyNodeShapeProps, type StoryNodeShape } from './story-node-shape';

const BADGE_TONE: Record<StoryNodeShape['props']['badgeTone'], string> = {
    none: 'text-content-muted',
    partial: 'text-content-default',
    complete: 'text-content-brand',
};

export class StoryNodeShapeUtil extends ShapeUtil<StoryNodeShape> {
    static override type = STORY_NODE_SHAPE_TYPE;
    static override props = storyNodeShapeProps;

    override getDefaultProps(): StoryNodeShape['props'] {
        return {
            w: NODE_DEFAULT_W,
            h: NODE_DEFAULT_H,
            elementId: '',
            lane: null,
            name: '',
            kindLabel: '',
            badgeLabel: '',
            badgeTone: 'none',
        };
    }

    override getGeometry(shape: StoryNodeShape): Rectangle2d {
        return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
    }

    override canBind(): boolean {
        return true;
    }

    override canResize(): boolean {
        return true;
    }

    override hideRotateHandle(): boolean {
        return true;
    }

    /** Resized within the bounds the save accepts, so a resize can never be refused at save. */
    override onResize(shape: StoryNodeShape, info: TLResizeInfo<StoryNodeShape>) {
        return resizeBox(shape, info, { minWidth: NODE_MIN_SIZE, minHeight: NODE_MIN_SIZE, maxWidth: NODE_MAX_SIZE, maxHeight: NODE_MAX_SIZE });
    }

    override component(shape: StoryNodeShape) {
        const { name, kindLabel, badgeLabel, badgeTone, elementId } = shape.props;
        return (
            <HTMLContainer
                id={shape.id}
                style={{ width: shape.props.w, height: shape.props.h }}
                className="flex h-full w-full flex-col gap-tight overflow-hidden rounded-md border border-border-default bg-bg-default p-compact"
                data-story-node={elementId}
            >
                <span className="truncate text-sm font-medium text-content-emphasis">{name}</span>
                <span className="flex items-center justify-between gap-tight text-xs text-content-muted">
                    <span className="truncate">{kindLabel}</span>
                    {badgeLabel !== '' && (
                        <span className={`shrink-0 ${BADGE_TONE[badgeTone]}`} data-story-node-badge={badgeTone}>
                            {badgeLabel}
                        </span>
                    )}
                </span>
            </HTMLContainer>
        );
    }

    override indicator(shape: StoryNodeShape) {
        return <rect width={shape.props.w} height={shape.props.h} rx={6} />;
    }
}
