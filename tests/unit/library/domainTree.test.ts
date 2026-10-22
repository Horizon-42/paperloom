import { describe, expect, it } from "vitest";
import type { Domain } from "@/types/models";
import {
  buildDomainTree,
  childrenOf,
  computeDomainMove,
  countPapersByDomain,
  domainPath,
  flattenTree,
  getDescendantIds,
  getSubtreeIds,
  isUnfiled,
  nextOrder,
  wouldCreateCycle,
} from "@/services/domainTree";

const d = (id: string, parentId: string | null, order: number, name = id): Domain => ({
  id,
  name,
  parentId,
  order,
  color: "#000",
});

// atm
// ├─ traj (轨迹预测)
// │  └─ lstm
// └─ sched
// ml
const sample = (): Domain[] => [
  d("ml", null, 1, "ML"),
  d("atm", null, 0, "ATM"),
  d("sched", "atm", 1, "调度"),
  d("traj", "atm", 0, "轨迹预测"),
  d("lstm", "traj", 0, "LSTM"),
];

/** 应用 computeDomainMove 的结果，返回新数组 */
function apply(domains: Domain[], dragId: string, drop: Parameters<typeof computeDomainMove>[2]): Domain[] {
  const updates = computeDomainMove(domains, dragId, drop);
  if (!updates) throw new Error("invalid move");
  const byId = new Map(updates.map((u) => [u.id, u]));
  return domains.map((x) => (byId.has(x.id) ? { ...x, ...byId.get(x.id)! } : x));
}

const ids = (xs: Domain[]) => xs.map((x) => x.id);

describe("buildDomainTree", () => {
  it("builds a sorted nested tree", () => {
    const tree = buildDomainTree(sample());
    expect(tree.map((n) => n.domain.id)).toEqual(["atm", "ml"]);
    expect(tree[0].children.map((n) => n.domain.id)).toEqual(["traj", "sched"]);
    expect(tree[0].children[0].children[0].domain.id).toBe("lstm");
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it("treats domains with a missing parent as roots", () => {
    const tree = buildDomainTree([d("a", null, 0), d("orphan", "gone", 0)]);
    expect(tree.map((n) => n.domain.id).sort()).toEqual(["a", "orphan"]);
  });

  it("still shows every domain when stored data already contains a cycle", () => {
    const tree = buildDomainTree([d("x", "y", 0), d("y", "x", 0)]);
    expect(flattenTree(tree).map((n) => n.domain.id).sort()).toEqual(["x", "y"]);
  });

  it("flattenTree respects collapsed nodes", () => {
    const tree = buildDomainTree(sample());
    expect(flattenTree(tree, (id) => id !== "traj").map((n) => n.domain.id)).toEqual(["atm", "traj", "sched", "ml"]);
    expect(flattenTree(tree, () => false).map((n) => n.domain.id)).toEqual(["atm", "ml"]);
  });
});

describe("descendants and cycles", () => {
  it("collects all descendants", () => {
    expect([...getDescendantIds(sample(), "atm")].sort()).toEqual(["lstm", "sched", "traj"]);
    expect(getDescendantIds(sample(), "lstm").size).toBe(0);
    expect(getSubtreeIds(sample(), "traj").sort()).toEqual(["lstm", "traj"]);
  });

  it("detects cycles", () => {
    expect(wouldCreateCycle(sample(), "atm", "lstm")).toBe(true);
    expect(wouldCreateCycle(sample(), "atm", "atm")).toBe(true);
    expect(wouldCreateCycle(sample(), "lstm", "atm")).toBe(false);
    expect(wouldCreateCycle(sample(), "atm", null)).toBe(false);
  });
});

describe("computeDomainMove", () => {
  it("drop inside makes it the last child", () => {
    const next = apply(sample(), "ml", { targetId: "traj", position: "inside" });
    expect(ids(childrenOf(next, "traj"))).toEqual(["lstm", "ml"]);
    expect(ids(childrenOf(next, null))).toEqual(["atm"]);
  });

  it("drop before / after reorders siblings", () => {
    let next = apply(sample(), "sched", { targetId: "traj", position: "before" });
    expect(ids(childrenOf(next, "atm"))).toEqual(["sched", "traj"]);
    next = apply(next, "sched", { targetId: "traj", position: "after" });
    expect(ids(childrenOf(next, "atm"))).toEqual(["traj", "sched"]);
  });

  it("drop between domains of another parent re-parents", () => {
    const next = apply(sample(), "lstm", { targetId: "ml", position: "before" });
    expect(ids(childrenOf(next, null))).toEqual(["atm", "lstm", "ml"]);
    expect(next.find((x) => x.id === "lstm")!.parentId).toBeNull();
    expect(childrenOf(next, "traj")).toEqual([]);
  });

  it("moves to root end", () => {
    const next = apply(sample(), "traj", { targetId: null, position: "inside" });
    expect(ids(childrenOf(next, null))).toEqual(["atm", "ml", "traj"]);
  });

  it("rejects moving into own subtree", () => {
    expect(computeDomainMove(sample(), "atm", { targetId: "lstm", position: "inside" })).toBeNull();
    expect(computeDomainMove(sample(), "atm", { targetId: "atm", position: "inside" })).toBeNull();
    // 放到子孙的前后 = 成为子孙的兄弟，同样形成环
    expect(computeDomainMove(sample(), "atm", { targetId: "lstm", position: "after" })).toBeNull();
    expect(computeDomainMove(sample(), "atm", { targetId: "traj", position: "before" })).toBeNull();
  });

  it("returns [] for no-op drops onto itself and null for missing targets", () => {
    expect(computeDomainMove(sample(), "traj", { targetId: "traj", position: "before" })).toEqual([]);
    expect(computeDomainMove(sample(), "traj", { targetId: "nope", position: "inside" })).toBeNull();
    expect(computeDomainMove(sample(), "nope", { targetId: "traj", position: "inside" })).toBeNull();
  });

  it("only reports changed placements", () => {
    const updates = computeDomainMove(sample(), "ml", { targetId: "atm", position: "after" });
    expect(updates).toEqual([]);
  });
});

describe("misc", () => {
  it("nextOrder", () => {
    expect(nextOrder(sample(), "atm")).toBe(2);
    expect(nextOrder(sample(), "lstm")).toBe(0);
  });

  it("domainPath", () => {
    expect(domainPath(sample(), "lstm")).toBe("ATM / 轨迹预测 / LSTM");
    expect(domainPath(sample(), "ml")).toBe("ML");
    expect(domainPath(sample(), "missing")).toBe("");
  });

  it("counts papers including sub-domains, once per subtree", () => {
    const papers = [{ domainIds: ["lstm"] }, { domainIds: ["traj", "lstm"] }, { domainIds: ["ml"] }, { domainIds: [] }];
    const c = countPapersByDomain(sample(), papers);
    expect(c.get("atm")).toBe(2);
    expect(c.get("traj")).toBe(2);
    expect(c.get("lstm")).toBe(2);
    expect(c.get("ml")).toBe(1);
    expect(c.get("sched")).toBeUndefined();
  });

  it("isUnfiled ignores ids of deleted domains", () => {
    const existing = new Set(["atm"]);
    expect(isUnfiled({ domainIds: [] }, existing)).toBe(true);
    expect(isUnfiled({ domainIds: ["gone"] }, existing)).toBe(true);
    expect(isUnfiled({ domainIds: ["gone", "atm"] }, existing)).toBe(false);
  });
});
