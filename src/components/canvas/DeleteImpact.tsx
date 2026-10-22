// 删除确认框里的影响说明："将同时删除 3 条连线和 2 块画布上的节点"。不依赖 React Flow。
import { useLiveQuery } from "dexie-react-hooks";
import { t } from "@/i18n";
import { entityDeleteImpact } from "@/services/canvasService";
import type { EntityRef } from "@/types/models";

export function describeDeleteImpact({ links, boards }: { links: number; boards: number }): string {
  return t.canvas.deleteImpact(links, boards);
}

/** 实时统计并显示删除某个实体的连带影响 */
export function EntityDeleteImpact({ entity }: { entity: EntityRef }) {
  const impact = useLiveQuery(() => entityDeleteImpact(entity), [entity.kind, entity.id]);
  if (!impact) return null;
  return <span data-delete-impact={`${impact.links},${impact.boards}`}>{describeDeleteImpact(impact)}</span>;
}
