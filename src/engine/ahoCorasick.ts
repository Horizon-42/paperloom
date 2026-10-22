// 通用多模式匹配（Aho-Corasick）。按 UTF-16 码元匹配，因此支持任意 Unicode（含中文、代理对）。
// 结构：根节点用 65536 项的直接索引表，其余节点的边按 CSR 连续存放、线性查找（子节点通常很少）。

export class AhoCorasick {
  /** 每个模式的长度（UTF-16 码元） */
  readonly lengths: Int32Array;
  readonly patternCount: number;

  private readonly rootNext: Int32Array;
  private readonly edgeStart: Int32Array;
  private readonly edgeCode: Uint16Array;
  private readonly edgeTarget: Int32Array;
  private readonly fail: Int32Array;
  /** 沿失败链最近的、有输出的节点（不含自身），0 表示没有 */
  private readonly dict: Int32Array;
  /** 以该节点结尾的模式链表：outHead[node] → 模式下标，outNext[模式] → 下一个 */
  private readonly outHead: Int32Array;
  private readonly outNext: Int32Array;

  /** 空模式会被忽略（永不命中）；重复模式各自报告 */
  constructor(patterns: readonly string[]) {
    const P = patterns.length;
    this.patternCount = P;
    this.lengths = new Int32Array(P);
    this.outNext = new Int32Array(P).fill(-1);

    // 1. 用链表建字典树
    const rootNext = new Int32Array(0x10000).fill(-1);
    const firstChild: number[] = [-1];
    const nextSibling: number[] = [-1];
    const code: number[] = [0];
    const outHeadList: number[] = [-1];
    let nodeCount = 1;

    for (let p = 0; p < P; p++) {
      const pat = patterns[p];
      this.lengths[p] = pat.length;
      if (pat.length === 0) continue;
      let node = 0;
      for (let k = 0; k < pat.length; k++) {
        const c = pat.charCodeAt(k);
        let nx: number;
        if (node === 0) {
          nx = rootNext[c];
        } else {
          nx = firstChild[node];
          while (nx >= 0 && code[nx] !== c) nx = nextSibling[nx];
        }
        if (nx < 0) {
          nx = nodeCount++;
          firstChild.push(-1);
          code.push(c);
          outHeadList.push(-1);
          nextSibling.push(firstChild[node]);
          firstChild[node] = nx;
          if (node === 0) rootNext[c] = nx;
        }
        node = nx;
      }
      this.outNext[p] = outHeadList[node];
      outHeadList[node] = p;
    }

    // 2. 转成 CSR
    const N = nodeCount;
    const edgeStart = new Int32Array(N + 1);
    const childCount = new Int32Array(N);
    for (let u = 0; u < N; u++) {
      let cnt = 0;
      for (let v = firstChild[u]; v >= 0; v = nextSibling[v]) cnt++;
      childCount[u] = cnt;
    }
    for (let u = 0; u < N; u++) edgeStart[u + 1] = edgeStart[u] + childCount[u];
    const edgeCode = new Uint16Array(Math.max(1, N - 1));
    const edgeTarget = new Int32Array(Math.max(1, N - 1));
    for (let u = 0; u < N; u++) {
      let e = edgeStart[u];
      for (let v = firstChild[u]; v >= 0; v = nextSibling[v]) {
        edgeCode[e] = code[v];
        edgeTarget[e] = v;
        e++;
      }
    }

    // 3. BFS 计算失败链接与输出链接
    const fail = new Int32Array(N);
    const dict = new Int32Array(N);
    const outHead = Int32Array.from(outHeadList);
    const queue = new Int32Array(N);
    let qh = 0;
    let qt = 0;
    for (let e = edgeStart[0]; e < edgeStart[1]; e++) {
      const v = edgeTarget[e];
      fail[v] = 0;
      dict[v] = 0;
      queue[qt++] = v;
    }
    while (qh < qt) {
      const u = queue[qh++];
      for (let e = edgeStart[u], ee = edgeStart[u + 1]; e < ee; e++) {
        const v = edgeTarget[e];
        const c = edgeCode[e];
        let f = fail[u];
        let target = 0;
        for (;;) {
          if (f === 0) {
            const r = rootNext[c];
            target = r > 0 ? r : 0;
            break;
          }
          let g = -1;
          for (let k = edgeStart[f], kk = edgeStart[f + 1]; k < kk; k++) {
            if (edgeCode[k] === c) {
              g = edgeTarget[k];
              break;
            }
          }
          if (g >= 0) {
            target = g;
            break;
          }
          f = fail[f];
        }
        fail[v] = target;
        dict[v] = outHead[target] >= 0 ? target : dict[target];
        queue[qt++] = v;
      }
    }

    this.rootNext = rootNext;
    this.edgeStart = edgeStart;
    this.edgeCode = edgeCode;
    this.edgeTarget = edgeTarget;
    this.fail = fail;
    this.dict = dict;
    this.outHead = outHead;
  }

  /**
   * 扫描 text，对每次命中回调 onMatch(模式下标, 结束位置)。
   * 结束位置不含（[end - lengths[p], end)）；同一结束位置的多个模式按从长到短报告。
   */
  search(text: string, onMatch: (patternIndex: number, end: number) => void): void {
    const { rootNext, edgeStart, edgeCode, edgeTarget, fail, dict, outHead, outNext } = this;
    let s = 0;
    for (let i = 0, n = text.length; i < n; i++) {
      const c = text.charCodeAt(i);
      for (;;) {
        if (s === 0) {
          const r = rootNext[c];
          s = r > 0 ? r : 0;
          break;
        }
        let g = -1;
        for (let k = edgeStart[s], kk = edgeStart[s + 1]; k < kk; k++) {
          if (edgeCode[k] === c) {
            g = edgeTarget[k];
            break;
          }
        }
        if (g >= 0) {
          s = g;
          break;
        }
        s = fail[s];
      }
      let o = outHead[s] >= 0 ? s : dict[s];
      while (o > 0) {
        for (let p = outHead[o]; p >= 0; p = outNext[p]) onMatch(p, i + 1);
        o = dict[o];
      }
    }
  }
}
