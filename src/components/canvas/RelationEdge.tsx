// 关系连线：端点浮动在两个节点的边框上；颜色/线型区分关系类型，中点显示关系文字，点击文字可修改或删除。
import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type EdgeProps, type InternalNode } from "@xyflow/react";
import { t } from "@/i18n";
import { useCanvasActions } from "./context";
import type { CanvasFlowEdge, CanvasFlowNode } from "./flow";
import { RELATION_STYLE, edgeGeometry, relationText, type Box } from "./model";
import { useLowDetail } from "./nodes";

const boxOf = (n: InternalNode<CanvasFlowNode>): Box => ({
  x: n.internals.positionAbsolute.x,
  y: n.internals.positionAbsolute.y,
  w: n.measured.width ?? n.width ?? 0,
  h: n.measured.height ?? n.height ?? 0,
});

export const RelationEdge = memo(function RelationEdge({ id, source, target, data, selected, markerEnd }: EdgeProps<CanvasFlowEdge>) {
  const s = useInternalNode<CanvasFlowNode>(source);
  const tg = useInternalNode<CanvasFlowNode>(target);
  const low = useLowDetail();
  const actions = useCanvasActions();
  if (!s || !tg || !data) return null;
  const g = edgeGeometry(boxOf(s), boxOf(tg), data.offset);
  const style = RELATION_STYLE[data.link.relation] ?? RELATION_STYLE.custom;
  const text = relationText(data.link);
  return (
    <>
      <BaseEdge
        id={id}
        path={g.path}
        markerEnd={markerEnd}
        interactionWidth={14}
        style={{ stroke: style.color, strokeWidth: selected ? 2.6 : 1.6, strokeDasharray: style.dash }}
      />
      {!low && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="pl-elabel nodrag nopan absolute max-w-[180px] truncate rounded-full border bg-white px-2 py-px text-[11px] leading-[17px] shadow-sm hover:shadow"
            style={{
              transform: `translate(-50%, -50%) translate(${g.labelX}px, ${g.labelY}px)`,
              color: style.color,
              borderColor: selected ? style.color : `color-mix(in srgb, ${style.color} 35%, white)`,
            }}
            title={t.canvas.edgeTitle(text)}
            data-edge-label={id}
            data-relation={data.link.relation}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              actions.openEdgeEditor(id, { x: r.left + r.width / 2, y: r.bottom });
            }}
          >
            {text}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes = { relation: RelationEdge };
