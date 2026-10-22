import MarkdownIt from "markdown-it";
import katexPluginModule from "@vscode/markdown-it-katex";

// 该插件是 CJS 包，不同打包器的默认导出互操作不一致，两种形态都兼容
const katexPlugin =
  (katexPluginModule as unknown as { default?: typeof katexPluginModule }).default ?? katexPluginModule;

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
md.use(katexPlugin, { throwOnError: false });

// 链接一律在新标签页打开，避免离开阅读器
const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/** Markdown（含 $…$ / $$…$$ 公式）→ HTML。html 选项关闭，用户输入的原始 HTML 会被转义 */
export function renderMarkdown(src: string): string {
  return md.render(src);
}
