import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/schema";
import {
  authorsAgree,
  findDoiCandidates,
  isPublished,
  lookupDois,
  normalizeDoi,
  parseDoiInput,
  pickWork,
  resetThrottleForTest,
  searchTitle,
  titleSimilarity,
  type OpenAlexWork,
} from "@/lib/openalex";
import { acceptCandidate, needsRefresh, refreshCitations } from "@/services/citationService";
import type { Paper } from "@/types/models";

function work(p: Partial<OpenAlexWork> & { id: string; display_name: string }): OpenAlexWork {
  return { publication_year: null, publication_date: null, cited_by_count: 0, doi: null, type: "article", ...p };
}

describe("normalizeDoi", () => {
  it.each([
    ["10.1016/J.NEUCOM.2023.127063", "10.1016/j.neucom.2023.127063"],
    ["https://doi.org/10.1145/3292500.3330701", "10.1145/3292500.3330701"],
    ["http://dx.doi.org/10.1000/xyz123.", "10.1000/xyz123"],
    ["doi: 10.1109/5.771073,", "10.1109/5.771073"],
    ["10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0", "10.1002/(sici)1097-4571(199806)49:8"],
    ["10.1000/abc(1)", "10.1000/abc(1)"],
    ["10.1000/abc)", "10.1000/abc"],
  ])("%s → %s", (raw, out) => expect(normalizeDoi(raw)).toBe(out));

  it("不像 DOI", () => {
    expect(normalizeDoi("")).toBeNull();
    expect(normalizeDoi("hello 10.1000/x")).toBeNull();
    expect(normalizeDoi("10.12/x")).toBeNull();
  });
});

describe("parseDoiInput（用户填写的，不截断）", () => {
  it.each([
    ["10.1145/3292500.3330701", "10.1145/3292500.3330701"],
    ["https://doi.org/10.1016/J.X.2023.1", "10.1016/j.x.2023.1"],
    ["DOI 10.1109/5.771073", "10.1109/5.771073"],
    ["doi：10.1109/5.771073", "10.1109/5.771073"],
    ["https://doi.org/10.1002%2F%28SICI%291097", "10.1002/(sici)1097"],
    ["10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0", "10.1002/(sici)1097-4571(199806)49:8<693::aid-asi4>3.0.co;2-0"],
  ])("%s → %s", (raw, out) => expect(parseDoiInput(raw)).toBe(out));

  it("整串必须是 DOI", () => {
    expect(parseDoiInput("10.1000/abc extra")).toBeNull();
    expect(parseDoiInput("see 10.1000/abc")).toBeNull();
    expect(parseDoiInput("")).toBeNull();
  });
});

describe("findDoiCandidates", () => {
  it("带 doi 标记的在前，arXiv 编号换算的在最后，去重", () => {
    const text = "See 10.1000/other for data. Neurocomputing https://doi.org/10.1016/j.neucom.2023.127063 arXiv:2104.09864v5 [cs.CL] DOI: 10.1016/J.NEUCOM.2023.127063";
    expect(findDoiCandidates(text)).toEqual([
      { doi: "10.1016/j.neucom.2023.127063", labeled: true },
      { doi: "10.1000/other", labeled: false },
      { doi: "10.48550/arxiv.2104.09864", labeled: false, arxiv: true },
    ]);
  });
});

describe("标题比对与版本挑选", () => {
  it("titleSimilarity 忽略大小写、标点、HTML 标签和变音符号", () => {
    expect(titleSimilarity("RoFormer: Enhanced Transformer with Rotary Position Embedding", "RoFormer — enhanced transformer with <i>rotary</i> position embedding")).toBe(1);
    expect(titleSimilarity("Café networks", "Cafe Networks")).toBe(1);
    expect(titleSimilarity("Attention is all you need", "Attention is not all you need")).toBeLessThan(0.95);
    expect(titleSimilarity("", "x")).toBe(0);
  });

  it("isPublished：预印本、预印本库里的、提交版都不算", () => {
    expect(isPublished(work({ id: "a", display_name: "x" }))).toBe(true);
    expect(isPublished(work({ id: "a", display_name: "x", type: "preprint" }))).toBe(false);
    expect(isPublished(work({ id: "a", display_name: "x", primary_location: { source: { type: "repository" } } }))).toBe(false);
    expect(isPublished(work({ id: "a", display_name: "x", primary_location: { version: "submittedVersion" } }))).toBe(false);
  });

  const paper = { title: "RoFormer: Enhanced Transformer with Rotary Position Embedding", authors: ["Jianlin Su", "Yu Lu"] };
  const authors = (...names: string[]) => names.map((n) => ({ author: { display_name: n } }));

  it("有正式版取正式版；同类取最新；标题或作者对不上的排除", () => {
    const pre = work({ id: "W1", display_name: paper.title, type: "preprint", publication_date: "2021-04-20", cited_by_count: 900, authorships: authors("Jianlin Su") });
    const conf = work({ id: "W2", display_name: paper.title, publication_date: "2022-01-01", cited_by_count: 100, authorships: authors("Jianlin Su") });
    const journal = work({ id: "W3", display_name: paper.title, publication_date: "2023-11-24", cited_by_count: 1934, authorships: authors("J. Su") });
    const otherAuthors = work({ id: "W4", display_name: paper.title, publication_date: "2025-01-01", authorships: authors("Someone Else") });
    const otherTitle = work({ id: "W5", display_name: "Rotary Position Embedding for Vision Transformer", publication_date: "2024-01-01" });
    expect(pickWork(paper, [pre, conf, journal, otherAuthors, otherTitle])?.id).toBe("W3");
    expect(pickWork(paper, [pre])?.id).toBe("W1");
    expect(pickWork(paper, [otherTitle, otherAuthors])).toBeNull();
    // 本地没有作者信息时不按作者排除
    expect(pickWork({ ...paper, authors: [] }, [otherAuthors])?.id).toBe("W4");
  });

  it("标题更长的别的作品（综述、勘误）不会因为更新而胜出；勘误等附属类型排除", () => {
    const title = "Deep Residual Learning for Image Recognition";
    const real = work({ id: "W1", display_name: title, publication_date: "2016-06-01", cited_by_count: 234864, authorships: authors("Kaiming He") });
    const survey = work({ id: "W2", display_name: `${title}: A Survey`, publication_date: "2022-01-01", authorships: authors("Someone Else") });
    const correction = work({ id: "W3", display_name: `Correction to: ${title}`, publication_date: "2023-01-01", authorships: authors("Kaiming He") });
    const erratum = work({ id: "W4", display_name: title, type: "erratum", publication_date: "2024-01-01", authorships: authors("Kaiming He") });
    expect(pickWork({ title, authors: ["Kaiming He"] }, [survey, correction, erratum, real])?.id).toBe("W1");
    // 本地没有作者：只认几乎完全相同的标题
    expect(pickWork({ title, authors: [] }, [survey, correction, real])?.id).toBe("W1");
    expect(pickWork({ title, authors: [] }, [survey, correction])).toBeNull();
  });

  it("authorsAgree：不分姓名顺序；中文名或缺作者时无法判断", () => {
    const w = (n: string) => work({ id: "W", display_name: "x", authorships: authors(n) });
    expect(authorsAgree({ authors: ["Zhang Wei"] }, w("Wei Zhang"))).toBe(true);
    expect(authorsAgree({ authors: ["Zhang Wei"] }, w("Li Na"))).toBe(false);
    expect(authorsAgree({ authors: ["张伟"] }, w("Wei Zhang"))).toBeNull();
    expect(authorsAgree({ authors: [] }, w("Wei Zhang"))).toBeNull();
  });
});

/** 假的 fetch：按 URL 路由；记下请求 */
function fakeFetch(routes: { doi?: Record<string, OpenAlexWork>; search?: Record<string, OpenAlexWork[]>; status?: number }) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(decodeURIComponent(url.pathname + url.search));
    if (routes.status) return new Response("limit", { status: routes.status });
    const m = /\/works\/doi:(.+)$/.exec(decodeURIComponent(url.pathname));
    if (m) {
      const w = routes.doi?.[m[1]];
      return w ? Response.json(w) : new Response("", { status: 404 });
    }
    const filter = url.searchParams.get("filter") ?? "";
    const q = filter.replace(/^title\.search:/, "");
    return Response.json({ results: routes.search?.[q] ?? [] });
  }) as typeof fetch;
  return { f, calls };
}

describe("请求", () => {
  it("lookupDois 逐个查、并发；404 不在结果里；带 api_key", async () => {
    const w = work({ id: "https://openalex.org/W1", display_name: "A" });
    const { f, calls } = fakeFetch({ doi: { "10.1234/a": w } });
    const out = await lookupDois(["10.1234/a", "10.1234/b"], { fetch: f, apiKey: "k" });
    expect([...out.found.keys()]).toEqual(["10.1234/a"]);
    expect([...out.done].sort()).toEqual(["10.1234/a", "10.1234/b"]);
    expect(out.error).toBeUndefined();
    expect(calls.every((c) => c.includes("api_key=k"))).toBe(true);
  });

  it("searchTitle 把逗号、冒号换成空格", async () => {
    const { f, calls } = fakeFetch({ search: { "A B C": [work({ id: "W", display_name: "A, B: C" })] } });
    expect(await searchTitle("A, B: C", { fetch: f })).toHaveLength(1);
    expect(calls[0]).toContain("title.search:A B C");
  });

  it("429 且今日额度用完 → quota 错误，返回已查到的部分；单个 5xx 当作查不到", async () => {
    let n = 0;
    const f = (async (input: RequestInfo | URL) => {
      n++;
      const url = decodeURIComponent(String(input));
      if (url.includes("10.1234/a")) return Response.json(work({ id: "https://openalex.org/WA", display_name: "A" }));
      if (url.includes("10.1234/b")) return new Response("", { status: 502 });
      return new Response("quota", { status: 429, headers: { "x-ratelimit-remaining-usd": "0" } });
    }) as typeof fetch;
    const out = await lookupDois(["10.1234/a", "10.1234/b", "10.1234/c", "10.1234/d", "10.1234/e", "10.1234/f"], { fetch: f });
    expect(out.error?.kind).toBe("quota");
    expect(out.found.has("10.1234/a")).toBe(true);
    expect(out.done.has("10.1234/b")).toBe(true);
    // 出错后其他的停下：不会把剩下的都请求一遍
    expect(n).toBeLessThan(6);
  });

  it("每秒限流的 429（今日额度还有剩）：等一下重试", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "1", "x-ratelimit-remaining-usd": "0.05" } });
      return Response.json(work({ id: "https://openalex.org/WA", display_name: "A" }));
    }) as typeof fetch;
    const out = await lookupDois(["10.1234/a"], { fetch: f });
    expect(out.found.has("10.1234/a")).toBe(true);
    expect(n).toBe(2);
  });
});

describe("refreshCitations", () => {
  beforeEach(async () => {
    resetThrottleForTest();
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  const base = (id: string, title: string, extra: Partial<Paper> = {}): Paper => ({
    id,
    fileHash: `h-${id}`,
    title,
    authors: ["Jianlin Su"],
    domainIds: [],
    pageCount: 1,
    addedAt: 1,
    ...extra,
  });

  it("填了 DOI 的按 DOI；没填的从前几页识别并核对标题；再不行按标题搜索；都没有记 notFound", async () => {
    await db.papers.bulkPut([
      base("p1", "Some Paper", { doi: "10.1234/given" }),
      base("p2", "RoFormer: Enhanced Transformer with Rotary Position Embedding"),
      base("p3", "Attention Is All You Need"),
      base("p4", "Nothing Matches Here"),
      base("p5", "2104.09864v5"), // 文件名当标题：不做标题搜索
      base("p6", "Wrong Detected DOI Paper"),
    ]);
    const pages: Record<string, string> = {
      p2: "arXiv:2104.09864v5 [cs.CL]",
      p6: "see 10.9999/unrelated and 10.9999/another",
    };
    const { f, calls } = fakeFetch({
      doi: {
        "10.1234/given": work({ id: "https://openalex.org/W1", display_name: "Some Paper", cited_by_count: 5, doi: "https://doi.org/10.1234/given" }),
        "10.48550/arxiv.2104.09864": work({
          id: "https://openalex.org/W2",
          display_name: "RoFormer: Enhanced transformer with Rotary Position Embedding",
          cited_by_count: 1934,
          doi: "https://doi.org/10.1016/j.neucom.2023.127063",
          publication_year: 2023,
        }),
        "10.9999/unrelated": work({ id: "https://openalex.org/W9", display_name: "Totally Different" }),
      },
      search: {
        "Attention Is All You Need": [
          work({ id: "https://openalex.org/W3", display_name: "Attention Is All You Need", type: "preprint", cited_by_count: 78269, publication_year: 2017 }),
        ],
      },
    });
    const progress: number[] = [];
    const r = await refreshCitations(["p1", "p2", "p3", "p4", "p5", "p6", "missing"], {
      fetch: f,
      now: () => 1000,
      readPages: async (id) => pages[id] ?? "",
      onProgress: (done) => progress.push(done),
    });
    expect(r.stopped).toBeUndefined();
    expect(r.outcomes.map((o) => `${o.paperId}:${o.status}`)).toEqual(["p1:found", "p2:found", "p3:found", "p4:notFound", "p5:found", "p6:notFound"]);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);

    const get = (id: string) => db.papers.get(id) as Promise<Paper>;
    expect((await get("p1")).citations).toEqual({ status: "found", count: 5, workId: "W1", matchedBy: "doi", matchedTitle: "Some Paper", matchedDoi: "10.1234/given", fetchedAt: 1000 });
    // 识别出的 arXiv DOI 核对过标题，写进 doi；引用数是 OpenAlex 合并后的作品的
    const p2 = await get("p2");
    expect(p2.doi).toBe("10.48550/arxiv.2104.09864");
    expect(p2.citations).toMatchObject({ status: "found", count: 1934, matchedBy: "doi", matchedDoi: "10.1016/j.neucom.2023.127063", matchedYear: 2023 });
    expect(await get("p3")).toMatchObject({ citations: { status: "found", matchedBy: "title", count: 78269, preprint: true } });
    expect((await get("p3")).doi).toBeUndefined();
    expect((await get("p4")).citations).toEqual({ status: "notFound", fetchedAt: 1000 });
    // 标题里的 arXiv 编号
    expect((await get("p5")).citations).toMatchObject({ status: "found", workId: "W2" });
    // 识别出的 DOI 标题对不上、也没有 doi 标记：不采用，也不写进 doi
    const p6 = await get("p6");
    expect(p6.doi).toBeUndefined();
    expect(p6.citations?.status).toBe("notFound");
    // 文件名标题不做标题搜索
    expect(calls.some((c) => c.includes("2104.09864v5"))).toBe(false);
  });

  it("额度用完：停止，其余为 skipped，不写入", async () => {
    await db.papers.bulkPut([base("p1", "A Real Title Here"), base("p2", "Another Real Title")]);
    const { f } = fakeFetch({ status: 429 });
    const r = await refreshCitations(["p1", "p2"], { fetch: f, readPages: async () => "" });
    expect(r.stopped?.kind).toBe("quota");
    expect(r.outcomes.map((o) => o.status)).toEqual(["skipped", "skipped"]);
    expect((await db.papers.get("p1"))?.citations).toBeUndefined();
  });

  it("查询期间用户改了 DOI：不覆盖用户的", async () => {
    await db.papers.put(base("p1", "RoFormer: Enhanced Transformer with Rotary Position Embedding"));
    const { f } = fakeFetch({
      doi: { "10.48550/arxiv.2104.09864": work({ id: "https://openalex.org/W2", display_name: "RoFormer: Enhanced transformer with Rotary Position Embedding" }) },
    });
    const slow: typeof fetch = async (input, init) => {
      await db.papers.update("p1", { doi: "10.5555/user" });
      return f(input, init);
    };
    const r = await refreshCitations(["p1"], { fetch: slow, readPages: async () => "arXiv:2104.09864" });
    const p = await db.papers.get("p1");
    expect(p?.doi).toBe("10.5555/user");
    // 查到的是旧 DOI 的结果：不写
    expect(p?.citations).toBeUndefined();
    expect(r.outcomes[0].status).toBe("skipped");
  });

  it("中途停止：抛出 AbortError，识别阶段也能停；已写入的保留", async () => {
    await db.papers.bulkPut([base("p1", "A Real Title Here"), base("p2", "Another Real Title")]);
    const ctl = new AbortController();
    const scans: number[] = [];
    const p = refreshCitations(["p1", "p2"], {
      fetch: fakeFetch({}).f,
      signal: ctl.signal,
      onScan: (done) => scans.push(done),
      readPages: async () => {
        ctl.abort();
        return "";
      },
    });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(scans).toEqual([0]);
    expect((await db.papers.get("p1"))?.citations).toBeUndefined();
  });

  it("额度在按 DOI 查询中途用完：DOI 已有结论的照常写入，其余 skipped", async () => {
    await db.papers.bulkPut([base("p1", "First Paper Title", { doi: "10.1234/one" }), base("p2", "Second Paper Title", { doi: "10.1234/two" })]);
    const f = (async (input: RequestInfo | URL) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("10.1234/one")) return Response.json(work({ id: "https://openalex.org/W1", display_name: "First Paper Title", cited_by_count: 3 }));
      return new Response("quota", { status: 429 });
    }) as typeof fetch;
    const r = await refreshCitations(["p1", "p2"], { fetch: f, readPages: async () => "" });
    expect(r.stopped?.kind).toBe("quota");
    expect(r.outcomes.map((o) => `${o.paperId}:${o.status}`)).toEqual(["p1:found", "p2:skipped"]);
  });

  it("acceptCandidate：唯一标了 doi 的候选也要标题有几分相似，或标题没意义但作者对得上", () => {
    const labeled = { doi: "10.1234/x", labeled: true };
    const other = work({ id: "W", display_name: "Completely Unrelated Reference Work", authorships: [{ author: { display_name: "Jianlin Su" } }] });
    const close = work({ id: "W", display_name: "RoFormer enhanced transformer", authorships: [] });
    const paper = base("p", "RoFormer: Enhanced Transformer with Rotary Position Embedding");
    expect(acceptCandidate(paper, labeled, [labeled], other)).toBe(false);
    expect(acceptCandidate(paper, labeled, [labeled], close)).toBe(true);
    expect(acceptCandidate(base("p", "2104_09864.pdf"), labeled, [labeled], other)).toBe(true);
    expect(acceptCandidate(base("p", "2104_09864.pdf", { authors: [] }), labeled, [labeled], other)).toBe(false);
  });

  it("needsRefresh：找到的 7 天、没找到的 30 天内不再查", () => {
    const day = 24 * 3600_000;
    expect(needsRefresh({}, 0)).toBe(true);
    expect(needsRefresh({ citations: { status: "notFound", fetchedAt: 0 } }, 10 * day)).toBe(false);
    expect(needsRefresh({ citations: { status: "notFound", fetchedAt: 0 } }, 31 * day)).toBe(true);
    expect(needsRefresh({ citations: { status: "found", count: 1, workId: "W", matchedBy: "doi", matchedTitle: "", fetchedAt: 0 } }, 8 * day)).toBe(true);
  });
});
