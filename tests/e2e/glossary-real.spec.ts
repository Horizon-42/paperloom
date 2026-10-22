/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// 真实论文检查：几篇论文导入后自动提取全文、建立索引，打印计数并截图术语表。
// PDF 只在浏览器内读取（测试结束即丢弃），不复制进仓库。
// PAPERLENS_LITERATURE_DIR=<你的论文目录> PAPERLENS_SHOTS_DIR=/path/to/dir \
//   npx playwright test -c tests/e2e/glossary.config.ts glossary-real
// PAPERLENS_REAL_EXTRA=<n>：再加 n 篇（按路径排序取前 n 篇、跳过 30 MB 以上的文件），测提取吞吐和主线程长任务
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { expect, test } from "@playwright/test";
import { LIT, SHOTS } from "./viewerHelpers";
import { addPdf, bootGlossary, getOccurrences, putDomains, putTerms, waitIndexed } from "./glossaryHelpers";

const PAPERS: { rel: string; domains: string[] }[] = [
  { rel: "multi_agent_interaction/papers/SocialLSTM_Alahi2016_social_lstm_human_trajectory_prediction_in_crowded_spaces.pdf", domains: ["d-traj"] },
  { rel: "multi_agent_interaction/papers/RelStateTransformer_Groot2022_relative_state_transformer_models_for_marl_in_air_traffic_control.pdf", domains: ["d-atm", "d-rl"] },
  { rel: "transformer/RoFormer_Su2021_enhanced_transformer_with_rotary_position_embedding.pdf", domains: ["d-dl"] },
  { rel: "manoeuvre_tokens/papers/LLM-FTP_Luo2025_large_language_models_for_single-step_and_multi-step_flight_trajectory_prediction.pdf", domains: ["d-traj"] },
  { rel: "multi_agent_interaction/papers/DA-STGCN_Kuang2025_4d_trajectory_prediction_based_on_spatiotemporal_feature_extraction.pdf", domains: ["d-traj"] },
  { rel: "multi_agent_interaction/papers/D2MAV-A_Brittain2020_deep_multi-agent_rl_approach_to_autonomous_separation_assurance.pdf", domains: ["d-atm", "d-rl"] },
];

const EXTRA = Number(process.env.PAPERLENS_REAL_EXTRA ?? 0);

function listPdfs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listPdfs(p));
    else if (name.toLowerCase().endsWith(".pdf") && st.size < 30e6) out.push(p);
  }
  return out.sort();
}

test("真实论文：自动提取全文并建立术语索引", async ({ page }) => {
  test.skip(!LIT, "设置 PAPERLENS_LITERATURE_DIR 后运行");
  test.setTimeout(300_000);
  await bootGlossary(page);

  await putDomains(page, [
    { id: "d-atm", name: "空中交通管理", color: "#3b82f6" },
    { id: "d-traj", name: "轨迹预测", parentId: "d-atm", color: "#10b981" },
    { id: "d-dl", name: "深度学习", color: "#8b5cf6" },
    { id: "d-rl", name: "强化学习", parentId: "d-dl", color: "#f59e0b" },
  ]);
  await putTerms(page, [
    { id: "t-lstm", name: "Long Short-Term Memory", aliases: ["LSTM"], note: "带输入门、遗忘门、输出门的**循环神经网络**，缓解梯度消失。\n\n- 常作为轨迹预测的基线\n- 对长序列仍不如 Transformer" },
    { id: "t-tf", name: "Transformer", aliases: ["self-attention"], note: "基于自注意力的序列模型（Vaswani 2017）。" },
    { id: "t-atc", name: "air traffic control", aliases: ["ATC"], domains: ["d-atm"], note: "空中交通管制。" },
    { id: "t-traj", name: "trajectory prediction", domains: ["d-atm"], note: "预测航空器未来的 4D 位置。" },
    { id: "t-rl", name: "reinforcement learning", aliases: ["RL"], domains: ["d-rl"], note: "通过与环境交互学习策略。" },
    { id: "t-gnn", name: "graph neural network", aliases: ["GNN", "GCN"], note: "在图结构上做消息传递。" },
    { id: "t-rope", name: "rotary position embedding", aliases: ["RoPE"], domains: ["d-dl"], note: "把位置编码成旋转矩阵，相对位置自然出现在内积中。$R_\\theta x$" },
    { id: "t-ade", name: "average displacement error", aliases: ["ADE"], domains: ["d-traj"], note: "预测轨迹与真值逐点距离的平均。" },
    { id: "t-aircraft", name: "aircraft" },
    { id: "t-llm", name: "large language model", aliases: ["LLM"], note: "" },
  ]);
  await page.evaluate(() => (window as any).__paperlens.useAppStore.getState().setView("glossary"));

  const chosen = PAPERS.map((p) => ({ file: join(LIT!, p.rel), domains: p.domains }));
  if (EXTRA > 0) {
    const fixed = new Set(chosen.map((c) => c.file));
    const more = listPdfs(LIT!).filter((f) => !fixed.has(f)).slice(0, EXTRA);
    chosen.push(...more.map((file) => ({ file, domains: relative(LIT!, file).startsWith("transformer") ? ["d-dl"] : ["d-atm"] })));
  }
  await page.evaluate(() => {
    const w = window as any;
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push(Math.round(e.duration));
    }).observe({ type: "longtask" });
  });
  const t0 = Date.now();
  const ids: string[] = [];
  for (const [i, p] of chosen.entries()) {
    if (!existsSync(p.file)) continue;
    const id = `real-${i}`;
    const title = basename(p.file, ".pdf").replace(/_/g, " ");
    await addPdf(page, readFileSync(p.file), id, title, p.domains);
    ids.push(id);
  }
  expect(ids.length).toBeGreaterThanOrEqual(5);
  // 打开第一篇：它应被优先提取
  await page.evaluate((id) => (window as any).__paperlens.useReaderStore.getState().openPaper(id), ids[0]);
  await page.evaluate(() => (window as any).__paperlens.useAppStore.getState().setView("glossary"));
  if (SHOTS) {
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, "glossary-indexing.png") });
  }
  await waitIndexed(page, 240_000);
  const elapsed = Date.now() - t0;

  const info = await page.evaluate(async (ids) => {
    const w = window as any;
    const db = w.__paperlens.db;
    return Promise.all(
      ids.map(async (id: string) => {
        const p = await db.papers.get(id);
        const texts = await db.pageTexts.where("paperId").equals(id).toArray();
        return { id, title: p.title, pageCount: p.pageCount, texts: texts.length, chars: texts.reduce((n: number, t: { text: string }) => n + t.text.length, 0) };
      }),
    );
  }, ids);
  const occ = await getOccurrences(page);
  const failures = await page.evaluate(() => (window as any).__paperlensGlossary.useIndexerStore.getState().failures);
  const longTasks: number[] = await page.evaluate(() => (window as any).__longTasks);
  const pages = info.reduce((n, p) => n + p.pageCount, 0);
  console.log(
    `[real] ${ids.length} 篇 ${pages} 页，提取 + 索引共 ${(elapsed / 1000).toFixed(1)} s；失败 ${failures.length}` +
      `；期间主线程长任务 ${longTasks.length} 个${longTasks.length ? `（最长 ${Math.max(...longTasks)} ms，>100ms 的 ${longTasks.filter((x) => x > 100).length} 个）` : ""}`,
  );
  for (const p of info.slice(0, PAPERS.length)) {
    const row = occ
      .filter((o) => o.paperId === p.id)
      .map((o) => `${o.termId.slice(2)}=${o.count}`)
      .join(" ");
    console.log(`[real] ${p.title.slice(0, 60).padEnd(60)} ${p.pageCount} 页 ${p.chars} 字符 | ${row}`);
    expect(p.texts).toBe(p.pageCount);
    expect(p.pageCount).toBeGreaterThan(3);
  }
  if (!EXTRA) expect(failures).toEqual([]);
  else console.log(`[real] 无法提取：${JSON.stringify(failures)}`);
  // 粗略的合理性：Social LSTM 论文里 LSTM 很多；RoFormer 里有 RoPE；ATC 只在空管领域的论文里
  const c = (term: string, paper: string) => occ.find((o) => o.termId === term && o.paperId === paper)?.count ?? 0;
  expect(c("t-lstm", "real-0")).toBeGreaterThan(20);
  expect(c("t-rope", "real-2")).toBeGreaterThan(5);
  expect(c("t-atc", "real-1")).toBeGreaterThan(5);
  expect(c("t-atc", "real-2")).toBe(0);
  expect(c("t-rl", "real-5")).toBeGreaterThan(5);

  // 截图：选中 Transformer，显示按领域分组的出现位置
  await page.evaluate(() => {
    const w = window as any;
    w.__paperlensGlossary.useGlossaryStore.getState().setSort({ key: "occurrences", dir: "desc" });
    w.__paperlensGlossary.useGlossaryStore.getState().select("t-lstm");
  });
  await expect(page.getByTestId("term-occurrence-summary")).toContainText("篇论文");
  if (SHOTS) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, "glossary-detail.png") });
    await page.evaluate(() => {
      const w = window as any;
      w.__paperlensGlossary.useGlossaryStore.getState().setFilter({ kind: "domain", id: "d-atm" });
      w.__paperlensGlossary.useGlossaryStore.getState().select("t-traj");
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, "glossary-domain-filter.png") });
  }
});
