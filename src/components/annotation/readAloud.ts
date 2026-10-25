// 朗读选中的段落（D19）：浏览器自带的语音合成（Web Speech API），零安装。
// 一句一句地读（部分浏览器长句读十几秒会中断；也便于按句高亮），读到的词由 boundary 事件给出（本机语音才有）。
import { saveRate, useReadAloudStore, type ReadAloudTarget } from "@/app/stores/readAloud";
import { detectLang, pickVoice, splitSentences, wordEnd } from "@/lib/speech";

export const RATES = [0.8, 1, 1.25, 1.5, 2] as const;

export const speechSupported = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

/** 每次开始朗读加一：旧的一次的回调发现编号不对就不再动作 */
let session = 0;

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

/** 开始朗读（会先停掉正在读的） */
export async function startReadAloud(target: ReadAloudTarget): Promise<void> {
  if (!speechSupported()) return;
  const synth = window.speechSynthesis;
  const my = ++session;
  synth.cancel();
  const st = useReadAloudStore.getState;
  const sentences = splitSentences(target.text);
  if (!sentences.length) return;
  st().set({ status: "speaking", target, sentence: null, word: null });
  const voice = pickVoice(await loadVoices(), detectLang(target.text));
  if (my !== session) return;

  const speak = (i: number) => {
    if (my !== session) return;
    if (i >= sentences.length) {
      stopReadAloud();
      return;
    }
    const s = sentences[i];
    const text = target.text.slice(s.start, s.end);
    const u = new SpeechSynthesisUtterance(text);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else u.lang = detectLang(text) === "zh" ? "zh-CN" : "en-US";
    u.rate = st().rate;
    const base = target.start + s.start;
    u.onstart = () => my === session && st().set({ sentence: { start: base, end: target.start + s.end }, word: null });
    u.onboundary = (e) => {
      if (my !== session || e.name !== "word") return;
      const len = e.charLength > 0 ? e.charLength : wordEnd(text, e.charIndex) - e.charIndex;
      if (len > 0) st().set({ word: { start: base + e.charIndex, end: base + e.charIndex + len } });
    };
    u.onend = () => speak(i + 1);
    // cancel() 也会触发 error（interrupted / canceled）：那是我们自己停的，由新一次朗读接手
    u.onerror = (e) => {
      if (my !== session || e.error === "interrupted" || e.error === "canceled") return;
      speak(i + 1);
    };
    synth.speak(u);
  };
  speak(0);
}

export function pauseReadAloud() {
  if (!speechSupported() || useReadAloudStore.getState().status !== "speaking") return;
  window.speechSynthesis.pause();
  useReadAloudStore.getState().set({ status: "paused" });
}

export function resumeReadAloud() {
  if (!speechSupported() || useReadAloudStore.getState().status !== "paused") return;
  window.speechSynthesis.resume();
  useReadAloudStore.getState().set({ status: "speaking" });
}

export function stopReadAloud() {
  session++;
  if (speechSupported()) window.speechSynthesis.cancel();
  useReadAloudStore.getState().set({ status: "idle", target: null, sentence: null, word: null });
}

/** 换语速：从当前句重新读（正在读的一句不能中途改语速） */
export function setReadAloudRate(rate: number) {
  const st = useReadAloudStore.getState();
  saveRate(rate);
  st.set({ rate });
  if (st.status === "idle" || !st.target) return;
  const from = st.sentence?.start ?? st.target.start;
  const t = st.target;
  void startReadAloud({ ...t, start: from, text: t.text.slice(from - t.start) });
}
