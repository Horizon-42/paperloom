// 朗读选中的段落（D19）：浏览器自带的语音合成（Web Speech API），零安装。
// 一段一段地读（部分浏览器长句读十几秒会中断；也便于按句高亮），读到的词由 boundary 事件给出（本机语音才有）。
import { useAnnotationStore } from "@/app/stores/annotation";
import { saveRate, useReadAloudStore, type ReadAloudTarget } from "@/app/stores/readAloud";
import { t } from "@/i18n";
import { detectLang, pickVoice, splitSentences, wordEnd } from "@/lib/speech";

export const RATES = [0.8, 1, 1.25, 1.5, 2] as const;

export const speechSupported = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

/** 每次开始朗读加一：旧的一次的回调发现编号不对就不再动作 */
let session = 0;
/** 正在读的一段：留着引用（旧版 Chrome 的语音对象被回收后不再触发 end） */
let current: SpeechSynthesisUtterance | null = null;
/** 暂停期间改了语速：继续时从当前句按新语速重读 */
let restartOnResume = false;
let watchdog = 0;

/** 语音列表是异步加载的：第一次取时可能为空，等 voiceschanged（最多 1 秒） */
async function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length) return now;
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener("voiceschanged", done);
      window.clearTimeout(timer);
      resolve(synth.getVoices());
    };
    const timer = window.setTimeout(done, 1000);
    synth.addEventListener("voiceschanged", done);
  });
}

/** 一段大约要读多久（毫秒）：英文约每秒 15 个字符，中文约每秒 4 个字 */
function estimateMs(text: string, rate: number): number {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  return ((text.length - han) / 15 + han / 4) * (1000 / rate);
}

function fail() {
  stopReadAloud();
  useAnnotationStore.getState().showToast(t.reader.readAloud.failed, { kind: "error" });
}

/** 开始朗读（会先停掉正在读的） */
export async function startReadAloud(target: ReadAloudTarget): Promise<void> {
  if (!speechSupported()) return;
  const sentences = splitSentences(target.text);
  if (!sentences.length) return; // 没有能读的文字：不打断正在读的
  const synth = window.speechSynthesis;
  const my = ++session;
  const busy = synth.speaking || synth.pending;
  synth.cancel();
  // cancel 不会解除暂停（Safari）：否则新的一段排在暂停的队列里不出声
  if (synth.paused) synth.resume();
  restartOnResume = false;
  const st = useReadAloudStore.getState;
  st().set({ status: "speaking", target, sentence: null, word: null });
  const voice = pickVoice(await loadVoices(), detectLang(target.text));
  // 刚 cancel 完立即 speak，部分浏览器会丢掉新的一段
  if (busy) await new Promise((r) => window.setTimeout(r, 50));
  if (my !== session) return;

  let errorsInRow = 0;
  const speak = (i: number) => {
    window.clearTimeout(watchdog);
    if (my !== session) return;
    if (i >= sentences.length) {
      stopReadAloud();
      return;
    }
    const s = sentences[i];
    const text = target.text.slice(s.start, s.end);
    const u = new SpeechSynthesisUtterance(text);
    current = u;
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else u.lang = detectLang(text) === "zh" ? "zh-CN" : "en-US";
    u.rate = st().rate;
    const base = target.start + s.start;
    // 有的浏览器 error 和 end 都会触发：一段只往下走一次
    let settled = false;
    const next = () => {
      if (settled) return;
      settled = true;
      speak(i + 1);
    };
    // 看门狗：读得远超预计还没结束（网络语音读长段会卡住，不触发 end 也不触发 error），跳到下一段
    const arm = () => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        if (my !== session || settled || st().status !== "speaking") return arm();
        settled = true;
        synth.cancel();
        speak(i + 1);
      }, estimateMs(text, u.rate) * 2 + 4000);
    };
    u.onstart = () => {
      if (my !== session) return;
      st().set({ sentence: { start: base, end: target.start + s.end }, word: null });
      arm();
    };
    u.onboundary = (e) => {
      if (my !== session || e.name !== "word") return;
      const len = e.charLength > 0 ? e.charLength : wordEnd(text, e.charIndex) - e.charIndex;
      if (len > 0) st().set({ word: { start: base + e.charIndex, end: base + e.charIndex + len } });
      arm();
    };
    u.onend = () => {
      if (my !== session) return;
      errorsInRow = 0;
      next();
    };
    u.onerror = (e) => {
      if (my !== session || settled) return;
      // 我们自己停的都会先换 session；到这里的打断来自别处（另一个标签页、系统）：停下，不卡在"正在朗读"
      if (e.error === "interrupted" || e.error === "canceled") return stopReadAloud();
      // 第一段就失败、或连续失败：语音不可用，停下并提示
      if (i === 0 || ++errorsInRow >= 2) return fail();
      next();
    };
    synth.speak(u);
    arm();
  };
  speak(0);
}

export function pauseReadAloud() {
  if (!speechSupported() || useReadAloudStore.getState().status !== "speaking") return;
  window.speechSynthesis.pause();
  useReadAloudStore.getState().set({ status: "paused" });
}

export function resumeReadAloud() {
  const st = useReadAloudStore.getState();
  if (!speechSupported() || st.status !== "paused") return;
  if (restartOnResume) {
    restartFromSentence();
    return;
  }
  window.speechSynthesis.resume();
  st.set({ status: "speaking" });
}

export function stopReadAloud() {
  session++;
  window.clearTimeout(watchdog);
  current = null;
  restartOnResume = false;
  if (speechSupported()) {
    window.speechSynthesis.cancel();
    if (window.speechSynthesis.paused) window.speechSynthesis.resume();
  }
  useReadAloudStore.getState().set({ status: "idle", target: null, sentence: null, word: null });
}

function restartFromSentence() {
  const st = useReadAloudStore.getState();
  if (!st.target) return;
  const t0 = st.target;
  const from = st.sentence?.start ?? t0.start;
  void startReadAloud({ ...t0, start: from, text: t0.text.slice(from - t0.start) });
}

/** 换语速：正在读时从当前句重新读（正在读的一句不能中途改语速）；暂停时等继续再按新语速读 */
export function setReadAloudRate(rate: number) {
  const st = useReadAloudStore.getState();
  saveRate(rate);
  st.set({ rate });
  if (st.status === "paused") restartOnResume = true;
  else if (st.status === "speaking") restartFromSentence();
}

// 刷新、关闭、切换项目或语言（都会重新加载页面）时停止，不让浏览器接着读
if (typeof window !== "undefined") window.addEventListener("pagehide", () => speechSupported() && window.speechSynthesis.cancel());

export const currentUtteranceForTest = () => current;
