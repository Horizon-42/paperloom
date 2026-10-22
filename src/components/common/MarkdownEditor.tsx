import { useEffect, useRef } from "react";
import { minimalSetup } from "codemirror";
import { Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** ⌘/Ctrl + Enter */
  onSubmit?: () => void;
  /** Esc */
  onCancel?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

const theme = EditorView.theme({
  "&": { fontSize: "0.875rem", backgroundColor: "white" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { padding: "6px 0", fontFamily: "inherit", minHeight: "4.5em" },
  ".cm-line": { padding: "0 8px" },
  ".cm-scroller": { maxHeight: "16em", overflow: "auto" },
});

/** 基于 CodeMirror 6 的 Markdown 编辑器。value 只在外部变化时同步进编辑器，编辑过程中不重建 */
export function MarkdownEditor({ value, onChange, onSubmit, onCancel, placeholder, autoFocus, className = "" }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 回调放进 ref，避免每次渲染都重建编辑器
  const callbacks = useRef({ onChange, onSubmit, onCancel });
  callbacks.current = { onChange, onSubmit, onCancel };

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      doc: value,
      extensions: [
        minimalSetup,
        markdown(),
        EditorView.lineWrapping,
        theme,
        cmPlaceholder(placeholder ?? ""),
        // minimalSetup 的默认键位把 Mod-Enter 绑到了 insertBlankLine，必须提高优先级才能先拿到
        Prec.highest(
          keymap.of([
            { key: "Mod-Enter", run: () => (callbacks.current.onSubmit?.(), true) },
            { key: "Escape", run: () => (callbacks.current.onCancel?.(), !!callbacks.current.onCancel) },
          ]),
        ),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) callbacks.current.onChange(u.state.doc.toString());
        }),
      ],
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => view.destroy();
    // 只在挂载时创建一次
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className={`overflow-hidden rounded border border-neutral-300 focus-within:border-blue-400 ${className}`} />;
}
