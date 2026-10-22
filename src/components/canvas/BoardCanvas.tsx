// 一块画布的 React Flow 视图：节点拖动/缩放/连线、拖入、定位请求、视口保存。
// 位置只在拖动结束时写一次（onNodeDragStop），视口在停止平移/缩放后防抖保存。
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type MutableRefObject } from "react";
import {
  Background,
  ConnectionLineType,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type InternalNode,
  type IsValidConnection,
  type NodeChange,
  type OnBeforeDelete,
  type Viewport,
  type XYPosition,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import { useAnnotationStore } from "@/app/stores/annotation";
import { useCanvasStore } from "@/app/stores/canvas";
import { useReaderStore } from "@/app/stores/reader";
import { useTermUiStore } from "@/app/stores/termUi";
import { jumpToAnnotation, reportError } from "@/components/annotation/actions";
import { PAPER_MIME, hasType } from "@/components/library/dnd";
import { compareInPaper } from "@/components/annotation/listModel";
import { listAnnotationsByPaper } from "@/db/repo/annotations";
import {
  DEFAULT_NODE_SIZE,
  addNodeToBoard,
  addNodesToBoard,
  createNoteOnBoard,
  findNodeForRef,
  moveBoardNodes,
  removeNodesFromBoard,
  resizeBoardNode,
  restoreBoardNodes,
} from "@/services/canvasService";
import { addLink, deleteLinks, listLinksFor, refKey, restoreLinks, updateLink } from "@/services/linkService";
import { deleteNote, restoreNote } from "@/services/noteService";
import type { Board, EntityKind, EntityRef, Link, LinkRelation } from "@/types/models";
import { CanvasActionsContext, type BoardBridge, type CanvasActions } from "./context";
import { ConfirmDialog } from "./dialogs";
import { reconcileEdges, reconcileNodes, type CanvasFlowEdge, type CanvasFlowNode, type Geometry } from "./flow";
import { REF_MIME, clip, decodeRef, externalLinks, gridLayout, linksToEdges, plainExcerpt } from "./model";
import { nodeTypes } from "./nodes";
import { RelationPicker } from "./RelationPicker";
import { edgeTypes } from "./RelationEdge";
import { useBoardContent, type BoardContent } from "./useBoardData";
import { initialViewport, saveViewport } from "./viewportMemory";

export function BoardCanvas({ board, bridgeRef }: { board: Board; bridgeRef: MutableRefObject<BoardBridge | null> }) {
  const content = useBoardContent(board.id);
  if (!content) return <div className="min-w-0 flex-1 bg-neutral-50" />;
  return <BoardFlow board={board} content={content} bridgeRef={bridgeRef} />;
}

type Confirm =
  | { kind: "note"; noteId: string; links: number }
  | { kind: "links"; linkIds: string[] };

let lastRelation: LinkRelation = "supports";

const MINIMAP_COLORS: Record<string, string> = { term: "#fcd34d", paper: "#93c5fd", note: "#fde047", missing: "#d4d4d4" };

function nodeTitle(n: CanvasFlowNode | undefined): string {
  const v = n?.data.view;
  if (!v) return "已删除的条目";
  if (v.kind === "annotation") return clip(v.annotation.quote.exact || "（无原文）", 40);
  if (v.kind === "term") return v.term.name;
  if (v.kind === "paper") return clip(v.paper.title, 40);
  return plainExcerpt(v.note.text, 40) || "（空笔记）";
}

const centerOf = (n: InternalNode<CanvasFlowNode>) => ({
  x: n.internals.positionAbsolute.x + (n.measured.width ?? 0) / 2,
  y: n.internals.positionAbsolute.y + (n.measured.height ?? 0) / 2,
});

/** 删除键只在焦点位于画布内（或没有焦点）且没有打开的浮层/对话框/菜单时生效 */
function deleteKeyAllowed(wrap: HTMLElement | null): boolean {
  if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return false;
  const a = document.activeElement;
  return !a || a === document.body || !!wrap?.contains(a);
}

function BoardFlow({ board, content, bridgeRef }: { board: Board; content: BoardContent; bridgeRef: MutableRefObject<BoardBridge | null> }) {
  const rf = useReactFlow<CanvasFlowNode, CanvasFlowEdge>();
  const boardId = board.id;
  const wrapRef = useRef<HTMLDivElement>(null);
  /** 已提交、数据库尚未回显的几何 */
  const pending = useRef(new Map<string, Partial<Geometry>>());
  const contentRef = useRef(content);
  contentRef.current = content;

  const edgeSpecs = useMemo(() => linksToEdges(content.links, content.nodes), [content]);
  // 另一端不在本画布上的连线（节点角上的"还有 k 条连线"）
  const external = useMemo(() => externalLinks(content.links, content.nodes), [content]);
  const externalRef = useRef(external);
  externalRef.current = external;
  const externalCounts = useMemo(() => new Map([...external].map(([id, ls]) => [id, ls.length])), [external]);
  const [nodes, setNodes] = useState(() => reconcileNodes([], content.nodes, content.views, undefined, externalCounts));
  const [edges, setEdges] = useState(() => reconcileEdges([], edgeSpecs));
  // 初始视口只在挂载时读取：本浏览器记住的视口，没有就适配全部节点
  const [initial] = useState(() => {
    const vp = initialViewport(board);
    return { viewport: vp ?? { x: 0, y: 0, zoom: 1 }, fit: !vp && content.nodes.length > 0 };
  });
  const [ready, setReady] = useState(false);
  const [pendingLink, setPendingLink] = useState<{ source: string; target: string; at: XYPosition } | null>(null);
  const [edgeEditor, setEdgeEditor] = useState<{ linkId: string; at: XYPosition } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  useEffect(() => {
    // 数据库已回显（或节点已不存在）的待写几何不再需要
    const p = pending.current;
    const byId = new Map(content.nodes.map((n) => [n.id, n]));
    for (const [id, g] of p) {
      const bn = byId.get(id);
      if (!bn || (["x", "y", "w", "h"] as const).every((k) => g[k] === undefined || g[k] === bn[k])) p.delete(id);
    }
    setNodes((prev) => reconcileNodes(prev, content.nodes, content.views, p, externalCounts));
  }, [content, externalCounts]);
  useEffect(() => setEdges((prev) => reconcileEdges(prev, edgeSpecs)), [edgeSpecs]);

  const onNodesChange = useCallback((changes: NodeChange<CanvasFlowNode>[]) => setNodes((nds) => applyNodeChanges(changes, nds)), []);
  const onEdgesChange = useCallback((changes: EdgeChange<CanvasFlowEdge>[]) => setEdges((eds) => applyEdgeChanges(changes, eds)), []);

  // ---------- 定位 ----------

  const focusNode = useCallback(
    (id: string, opts?: { edit?: boolean }) => {
      const n = rf.getNode(id);
      const bn = contentRef.current.nodes.find((x) => x.id === id);
      const g = n ? { x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 } : bn;
      if (!g) return;
      void rf.setCenter(g.x + g.w / 2, g.y + g.h / 2, { zoom: Math.max(rf.getZoom(), 0.85), duration: 350 });
      setNodes((nds) => nds.map((x) => (!!x.selected === (x.id === id) ? x : { ...x, selected: x.id === id })));
      const st = useCanvasStore.getState();
      st.flashNode(id);
      if (opts?.edit) st.setEditingNode(id);
    },
    [rf],
  );

  /** 视口中央（画布坐标）放一个 kind 类型节点的左上角；中央已有节点时错开 */
  const centerPos = useCallback(
    (kind: EntityKind): XYPosition => {
      const r = wrapRef.current!.getBoundingClientRect();
      const c = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      const { w, h } = DEFAULT_NODE_SIZE[kind];
      let x = c.x - w / 2;
      let y = c.y - h / 2;
      const taken = contentRef.current.nodes;
      for (let i = 0; i < 12 && taken.some((n) => Math.abs(n.x - x) < 12 && Math.abs(n.y - y) < 12); i++) {
        x += 28;
        y += 28;
      }
      return { x, y };
    },
    [rf],
  );

  const place = useCallback(
    async (ref: EntityRef, pos: XYPosition) => {
      try {
        const res = await addNodeToBoard(boardId, ref, pos);
        if (res.existed) {
          focusNode(res.node.id);
          useAnnotationStore.getState().showToast("已在这块画布上，已定位到该节点");
        } else {
          useCanvasStore.getState().flashNode(res.node.id);
        }
      } catch (e) {
        reportError("放到画布失败")(e);
      }
    },
    [boardId, focusNode],
  );

  const newNote = useCallback(
    async (pos: XYPosition) => {
      try {
        const { node } = await createNoteOnBoard(boardId, pos);
        const st = useCanvasStore.getState();
        st.setEditingNode(node.id);
        st.flashNode(node.id);
      } catch (e) {
        reportError("新建笔记失败")(e);
      }
    },
    [boardId],
  );

  useEffect(() => {
    bridgeRef.current = {
      placeAtCenter: (ref) => void place(ref, centerPos(ref.kind)),
      newNoteAtCenter: () => void newNote(centerPos("note")),
      focusRef: (ref) => {
        const bn = findNodeForRef(contentRef.current.nodes, boardId, ref);
        if (!bn) return false;
        focusNode(bn.id);
        return true;
      },
    };
    return () => {
      bridgeRef.current = null;
    };
  }, [bridgeRef, place, newNote, centerPos, focusNode, boardId]);

  // 其他模块发来的定位请求（PDF 角注的连线数、"放到画布"）
  const focus = useCanvasStore((s) => s.focus);
  const placing = useRef(new Set<number>());
  useEffect(() => {
    if (!ready || !focus || focus.boardId !== boardId) return;
    const st = useCanvasStore.getState();
    const bn = findNodeForRef(content.nodes, boardId, focus.ref);
    if (bn) {
      focusNode(bn.id, { edit: focus.edit });
      st.clearFocus(focus.seq);
      return;
    }
    if (focus.place) {
      if (placing.current.has(focus.seq)) return;
      placing.current.add(focus.seq);
      addNodeToBoard(boardId, focus.ref, centerPos(focus.ref.kind)).catch((e: unknown) => {
        reportError("放到画布失败")(e);
        st.clearFocus(focus.seq);
      });
      return;
    }
    useAnnotationStore.getState().showToast("这块画布上没有该条目");
    st.clearFocus(focus.seq);
  }, [ready, focus, content, boardId, focusNode, centerPos]);

  // ---------- 写入 ----------

  const onNodeDragStop = useCallback(
    (_: unknown, __: unknown, dragged: CanvasFlowNode[]) => {
      const byId = new Map(contentRef.current.nodes.map((n) => [n.id, n]));
      const moves = dragged
        .filter((n) => {
          const bn = byId.get(n.id);
          return bn && (bn.x !== n.position.x || bn.y !== n.position.y);
        })
        .map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }));
      if (!moves.length) return;
      for (const m of moves) pending.current.set(m.id, { ...pending.current.get(m.id), x: m.x, y: m.y });
      moveBoardNodes(boardId, moves).catch(reportError("保存位置失败"));
    },
    [boardId],
  );

  const removeNodes = useCallback(async (ids: string[]) => {
    const st = useCanvasStore.getState();
    if (st.editingNodeId && ids.includes(st.editingNodeId)) st.setEditingNode(null);
    try {
      const removed = await removeNodesFromBoard(ids);
      if (!removed.length) return;
      useAnnotationStore
        .getState()
        .showToast(removed.length === 1 ? "已移出画布（条目和连线都保留）" : `已移出 ${removed.length} 个节点（条目和连线都保留）`, {
          undo: () => restoreBoardNodes(removed),
        });
    } catch (e) {
      reportError("移出画布失败")(e);
    }
  }, []);

  /** 某个节点旁边的空位（右侧，依次往下错开） */
  const besideNode = useCallback(
    (nodeId: string, kind: EntityKind): XYPosition => {
      const n = rf.getNode(nodeId);
      const bn = contentRef.current.nodes.find((x) => x.id === nodeId);
      const g = n ? { x: n.position.x, y: n.position.y, w: n.width ?? 0 } : bn ? { x: bn.x, y: bn.y, w: bn.w } : { x: 0, y: 0, w: 0 };
      const x = g.x + g.w + 80;
      let y = g.y;
      const { h } = DEFAULT_NODE_SIZE[kind];
      const taken = contentRef.current.nodes;
      for (let i = 0; i < 20 && taken.some((t) => t.x < x + 200 && t.x + t.w > x && t.y < y + h && t.y + t.h > y); i++) y += h + 24;
      return { x, y };
    },
    [rf],
  );

  const addPaperAnnotations = useCallback(
    async (nodeId: string, paperId: string) => {
      const toast = useAnnotationStore.getState().showToast;
      try {
        const here = new Set(contentRef.current.nodes.map((n) => refKey(n.ref)));
        const all = (await listAnnotationsByPaper(paperId)).sort(compareInPaper);
        const todo = all.filter((a) => !here.has(`annotation:${a.id}`));
        if (!all.length) return toast("这篇论文还没有批注");
        if (!todo.length) return toast("这篇论文的批注都已在这块画布上");
        const n = rf.getNode(nodeId);
        const origin = n ? { x: n.position.x, y: n.position.y + (n.height ?? 0) + 60 } : centerPos("annotation");
        const pos = gridLayout(origin, todo.length, DEFAULT_NODE_SIZE.annotation);
        const added = await addNodesToBoard(
          boardId,
          todo.map((a, i) => ({ ref: { kind: "annotation" as const, id: a.id }, ...pos[i] })),
        );
        toast(`已放入 ${added.length} 条批注`, { undo: () => removeNodesFromBoard(added.map((x) => x.id)).then(() => undefined) });
      } catch (e) {
        reportError("放入批注失败")(e);
      }
    },
    [rf, boardId, centerPos],
  );

  const actions = useMemo<CanvasActions>(
    () => ({
      boardId,
      removeNodes: (ids) => void removeNodes(ids),
      externalOf: (nodeId) => externalRef.current.get(nodeId) ?? [],
      placeNear: (nodeId, ref) => void place(ref, besideNode(nodeId, ref.kind)),
      addPaperAnnotations: (nodeId, paperId) => void addPaperAnnotations(nodeId, paperId),
      resizeNode: (id, g) => {
        pending.current.set(id, g);
        resizeBoardNode(boardId, id, g).catch(reportError("保存大小失败"));
      },
      deleteNote: (noteId) => {
        void listLinksFor({ kind: "note", id: noteId }).then((ls) => setConfirm({ kind: "note", noteId, links: ls.length }));
      },
      openEdgeEditor: (linkId, at) => setEdgeEditor({ linkId, at }),
    }),
    [boardId, removeNodes, place, besideNode, addPaperAnnotations],
  );

  const onBeforeDelete = useCallback<OnBeforeDelete<CanvasFlowNode, CanvasFlowEdge>>(
    async ({ nodes: ns, edges: es }) => {
      // React Flow 在 document 上监听删除键，只放过输入框。焦点在浮层、对话框、菜单、侧栏里时不处理
      if (!deleteKeyAllowed(wrapRef.current)) return false;
      // React Flow 删除节点时会连带相连的边；这里只把节点移出画布，连线保留
      if (ns.length) void removeNodes(ns.map((n) => n.id));
      else if (es.length) setConfirm({ kind: "links", linkIds: es.map((e) => e.id) });
      return false;
    },
    [removeNodes],
  );

  const doDeleteNote = async (noteId: string) => {
    try {
      const snap = await deleteNote(noteId);
      if (snap) useAnnotationStore.getState().showToast("已删除笔记", { undo: () => restoreNote(snap) });
    } catch (e) {
      reportError("删除笔记失败")(e);
    }
  };

  const doDeleteLinks = async (ids: string[]) => {
    const toast = useAnnotationStore.getState().showToast;
    try {
      const snap = await deleteLinks(ids);
      if (!snap.length) return;
      toast(snap.length === 1 ? "已删除连线（所有画布中都已移除）" : `已删除 ${snap.length} 条连线（所有画布中都已移除）`, {
        undo: async () => {
          const n = await restoreLinks(snap);
          if (n < snap.length) toast(n ? `恢复了 ${n} 条，其余连线的一端已被删除` : "无法恢复：连线的一端已被删除");
        },
      });
    } catch (e) {
      reportError("删除连线失败")(e);
    }
  };

  const selectEdge = (id: string) => setEdges((eds) => eds.map((e) => (!!e.selected === (e.id === id) ? e : { ...e, selected: e.id === id })));

  // ---------- 连线 ----------

  const isValidConnection = useCallback<IsValidConnection<CanvasFlowEdge>>(
    (c) => c.source !== c.target && rf.getNode(c.source)?.type !== "missing" && rf.getNode(c.target)?.type !== "missing",
    [rf],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const s = rf.getInternalNode(c.source);
      const t = rf.getInternalNode(c.target);
      if (!s || !t) return;
      const a = centerOf(s);
      const b = centerOf(t);
      setPendingLink({ source: c.source, target: c.target, at: rf.flowToScreenPosition({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) });
    },
    [rf],
  );

  const submitLink = (relation: LinkRelation, label: string) => {
    const p = pendingLink;
    setPendingLink(null);
    if (!p) return;
    const from = rf.getNode(p.source)?.data.ref;
    const to = rf.getNode(p.target)?.data.ref;
    if (!from || !to) return;
    lastRelation = relation;
    addLink({ from, to, relation, label })
      .then(({ link, existed }) => {
        if (!existed) return;
        selectEdge(link.id);
        useAnnotationStore.getState().showToast("这条连线已存在，已选中它");
      })
      .catch(reportError("新建连线失败"));
  };

  const editingLink = edgeEditor ? content.links.find((l) => l.id === edgeEditor.linkId) : undefined;
  useEffect(() => {
    if (edgeEditor && !editingLink) setEdgeEditor(null); // 在别处被删除
  }, [edgeEditor, editingLink]);

  // ---------- 交互 ----------

  const onNodeDoubleClick = useCallback((e: ReactMouseEvent, node: CanvasFlowNode) => {
    if ((e.target as Element).closest("[data-node-editor], button, a, input")) return;
    const v = node.data.view;
    if (!v) return;
    if (v.kind === "annotation") jumpToAnnotation(v.annotation);
    else if (v.kind === "term") useTermUiStore.getState().openTermEditor({ termId: v.term.id });
    else if (v.kind === "paper") useReaderStore.getState().openPaper(v.paper.id);
    else useCanvasStore.getState().setEditingNode(node.id);
  }, []);

  const onEdgeClick = useCallback((e: ReactMouseEvent, edge: CanvasFlowEdge) => setEdgeEditor({ linkId: edge.id, at: { x: e.clientX, y: e.clientY } }), []);

  // 视口：停止平移/缩放 300ms 后存进 localStorage；卸载（切换画布、离开画布视图）时立即保存
  const vpTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastVp = useRef<Viewport | null>(null);
  const flushViewport = useCallback(() => {
    clearTimeout(vpTimer.current);
    const vp = lastVp.current;
    lastVp.current = null;
    if (vp) saveViewport(boardId, vp);
  }, [boardId]);
  const onMoveEnd = useCallback(
    (_: unknown, vp: Viewport) => {
      lastVp.current = vp;
      clearTimeout(vpTimer.current);
      vpTimer.current = setTimeout(flushViewport, 300);
    },
    [flushViewport],
  );
  // 卸载时记下当前视口（即使没动过），下次打开这块画布时原样恢复
  const readyRef = useRef(false);
  readyRef.current = ready;
  useEffect(
    () => () => {
      if (readyRef.current && !lastVp.current) lastVp.current = rf.getViewport();
      flushViewport();
    },
    [flushViewport, rf],
  );

  const onDragOver = (e: DragEvent) => {
    if (hasType(e, REF_MIME) || hasType(e, PAPER_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onDrop = (e: DragEvent) => {
    const paperId = e.dataTransfer.getData(PAPER_MIME);
    const ref: EntityRef | null = decodeRef(e.dataTransfer.getData(REF_MIME)) ?? (paperId ? { kind: "paper", id: paperId } : null);
    if (!ref) return;
    e.preventDefault();
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    void place(ref, { x: p.x - DEFAULT_NODE_SIZE[ref.kind].w / 2, y: p.y - 16 });
  };
  const onDoubleClick = (e: ReactMouseEvent) => {
    if (!(e.target as Element).classList?.contains("react-flow__pane")) return;
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    void newNote({ x: p.x - DEFAULT_NODE_SIZE.note.w / 2, y: p.y - 20 });
  };

  const linkEnds = (l: Link) => {
    const byRef = (r: EntityRef) => rf.getNodes().find((n) => n.data.ref.kind === r.kind && n.data.ref.id === r.id);
    return { from: nodeTitle(byRef(l.from)), to: nodeTitle(byRef(l.to)) };
  };

  return (
    <CanvasActionsContext.Provider value={actions}>
      <div
        ref={wrapRef}
        className="pl-canvas relative min-w-0 flex-1 bg-neutral-50"
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDoubleClick={onDoubleClick}
        data-canvas-flow={boardId}
      >
        <ReactFlow<CanvasFlowNode, CanvasFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onNodeDragStop={onNodeDragStop}
          onNodeDoubleClick={onNodeDoubleClick}
          onEdgeClick={onEdgeClick}
          onBeforeDelete={onBeforeDelete}
          onMoveEnd={onMoveEnd}
          onInit={() => setReady(true)}
          defaultViewport={initial.viewport}
          fitView={initial.fit}
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.05}
          maxZoom={2}
          connectionMode={ConnectionMode.Loose}
          connectionLineType={ConnectionLineType.Straight}
          connectionLineStyle={{ stroke: "#3b82f6", strokeWidth: 1.6 }}
          connectionRadius={24}
          deleteKeyCode={["Backspace", "Delete"]}
          zoomOnDoubleClick={false}
          panOnScroll
          onlyRenderVisibleElements
        >
          <Background gap={24} size={1.2} color="#d4d4d4" />
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeColor={(n: CanvasFlowNode) => (n.data.view?.kind === "annotation" ? n.data.view.annotation.color : (MINIMAP_COLORS[n.type ?? ""] ?? "#e5e5e5"))}
            nodeStrokeWidth={0}
            maskColor="rgb(245 245 245 / 0.7)"
            style={{ width: 168, height: 112 }}
            className="!rounded-md !border !border-neutral-200"
          />
        </ReactFlow>
        {content.nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="max-w-sm text-center text-[13px] leading-relaxed text-neutral-400">
              从左侧把批注、术语或论文拖到这里，
              <br />
              或双击空白处新建一条笔记。
              <br />
              从节点边缘的圆点拖到另一个节点即可连线。
            </div>
          </div>
        )}
      </div>

      {pendingLink && (
        <RelationPicker
          anchor={pendingLink.at}
          mode="create"
          initial={{ relation: lastRelation }}
          endpoints={{ from: nodeTitle(rf.getNode(pendingLink.source)), to: nodeTitle(rf.getNode(pendingLink.target)) }}
          onSubmit={submitLink}
          onClose={() => setPendingLink(null)}
        />
      )}
      {edgeEditor && editingLink && (
        <RelationPicker
          key={editingLink.id}
          anchor={edgeEditor.at}
          mode="edit"
          initial={{ relation: editingLink.relation, label: editingLink.label }}
          endpoints={linkEnds(editingLink)}
          onSubmit={(relation, label, reverse) => {
            setEdgeEditor(null);
            updateLink(editingLink.id, { relation, label, reverse })
              .then((r) => {
                if (!r?.merged) return;
                selectEdge(r.id);
                useAnnotationStore.getState().showToast("与已有的连线完全相同，已合并为一条");
              })
              .catch(reportError("修改连线失败"));
          }}
          onDelete={() => {
            setEdgeEditor(null);
            void doDeleteLinks([editingLink.id]);
          }}
          onClose={() => setEdgeEditor(null)}
        />
      )}
      {confirm?.kind === "note" && (
        <ConfirmDialog
          title="删除这条笔记？"
          testId="delete-note"
          body={
            <>
              笔记内容会被删除，所有画布上的这张卡片{confirm.links ? `和它的 ${confirm.links} 条连线` : ""}也会一起删除。
              {" "}只想从这块画布上拿掉的话，请用「移出画布」。
            </>
          }
          confirmText="删除笔记"
          danger
          onConfirm={() => void doDeleteNote(confirm.noteId)}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "links" && (
        <ConfirmDialog
          title={confirm.linkIds.length === 1 ? "删除这条连线？" : `删除 ${confirm.linkIds.length} 条连线？`}
          testId="delete-links"
          body="连线是全局的：删除后会从所有画布和术语弹窗的「相关笔记」中一起消失。两端的条目不受影响。"
          confirmText="删除连线"
          danger
          onConfirm={() => void doDeleteLinks(confirm.linkIds)}
          onClose={() => setConfirm(null)}
        />
      )}
    </CanvasActionsContext.Provider>
  );
}

