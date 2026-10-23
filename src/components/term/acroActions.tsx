// 术语 → acro：复制单条到剪贴板、导出整个术语表为 .tex
import { useEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import { useAnnotationStore } from "@/app/stores/annotation";
import { t } from "@/i18n";
import { assignAcroIds, declareAcronym, glossaryToAcro } from "@/lib/acro";
import { downloadText } from "@/services/storage/exportImport";
import type { Term } from "@/types/models";
import { IconCheck, IconCopy, cx, iconBtn } from "./ui";

const EXPORT_FILE = "glossary";
const COPIED_MS = 1500;

/** 复制一条术语的 \DeclareAcronym。acroId 用全部术语分配的那个，和导出文件里的一致 */
export async function copyAcro(term: Term, acroId: string): Promise<boolean> {
  const toast = useAnnotationStore.getState().showToast;
  try {
    await navigator.clipboard.writeText(declareAcronym(term, acroId));
    toast(t.term.acro.copied(acroId));
    return true;
  } catch {
    toast(t.term.acro.copyFailed, { kind: "error" });
    return false;
  }
}

/** 导出 terms 为 glossary.tex；id 按全部术语分配（allTerms），只导出一部分时也不会变 */
export function exportAcro(terms: readonly Term[], allTerms: readonly Term[]): void {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const header = t.term.acro.fileHeader({ date, count: terms.length, file: EXPORT_FILE });
  const file = `${EXPORT_FILE}.tex`;
  downloadText(file, glossaryToAcro(terms, header, assignAcroIds(allTerms)), "application/x-tex;charset=utf-8");
  useAnnotationStore.getState().showToast(t.term.acro.exported(terms.length, file));
}

/** 复制按钮：复制成功后短暂显示对勾 */
export function CopyAcroButton({
  term,
  acroId,
  title,
  className,
  ...rest
}: { term: Term; acroId: string; title?: string; className?: string } & Pick<ButtonHTMLAttributes<HTMLButtonElement>, "tabIndex" | "aria-hidden">) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={cx(iconBtn, className)}
      title={title ?? t.term.acro.copyTitle}
      aria-label={t.term.acro.copy}
      data-copy-acro
      {...rest}
      onClick={() => {
        void copyAcro(term, acroId).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
        });
      }}
    >
      {copied ? <IconCheck width={14} height={14} className="text-emerald-600" /> : <IconCopy />}
    </button>
  );
}
