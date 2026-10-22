// 全库每个术语的出现统计。读 Worker 随写入增量维护的统计记录（kv 里的一条，约几十 KB），
// 不再在主线程读整张 occurrences 表；写入只当作信号，节流后再读。
// 统计记录还不存在时（索引未运行过）退回到读全表，只统计论文仍存在的记录。
import { useEffect, useState } from "react";
import Dexie, { type ObservabilitySet } from "dexie";
import { db } from "@/db/schema";
import { getTermStatsRecord, listAllOccurrences } from "@/db/repo/occurrences";
import { aggregateOccurrences, statsFromRecord, type TermStats } from "./model";

async function loadStats(): Promise<Map<string, TermStats>> {
  const rec = await getTermStatsRecord();
  if (rec) return statsFromRecord(rec);
  const [rows, paperIds] = await Promise.all([listAllOccurrences(), db.papers.toCollection().primaryKeys()]);
  return aggregateOccurrences(rows, new Set(paperIds));
}

export function useOccurrenceStats(throttleMs = 500): Map<string, TermStats> | undefined {
  const [stats, setStats] = useState<Map<string, TermStats>>();

  useEffect(() => {
    const prefixes = [`idb://${db.name}/kv/`, `idb://${db.name}/occurrences/`];
    let disposed = false;
    let running = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;

    const run = async () => {
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      last = Date.now();
      try {
        const next = await loadStats();
        if (!disposed) setStats(next);
      } catch (e) {
        console.warn("[glossary] failed to load occurrence stats", e);
      } finally {
        running = false;
        if (dirty && !disposed) {
          dirty = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      if (timer || disposed) return;
      timer = setTimeout(
        () => {
          timer = null;
          void run();
        },
        Math.max(0, last + throttleMs - Date.now()),
      );
    };
    const onMutated = (parts: ObservabilitySet) => {
      for (const k in parts) {
        if (prefixes.some((p) => k.startsWith(p))) {
          schedule();
          return;
        }
      }
    };

    Dexie.on.storagemutated.subscribe(onMutated);
    void run();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      Dexie.on.storagemutated.unsubscribe(onMutated);
    };
  }, [throttleMs]);

  return stats;
}
