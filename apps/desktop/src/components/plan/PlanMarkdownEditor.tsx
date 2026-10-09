import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import type { PlanDraftAction } from "../../features/plan/plan-draft-model";

const EXTENSIONS = [
  StarterKit.configure({ link: { openOnClick: false } }),
  TableKit.configure({ table: { resizable: false } }),
  Markdown.configure({ markedOptions: { gfm: true } }),
];

/** Soft line breaks render as spaces; ProseMirror would keep them as hard breaks. */
function unwrapSoftBreaks(node: JSONContent): JSONContent {
  if (node.type === "codeBlock") return node;
  return {
    ...node,
    ...(node.text !== undefined ? { text: node.text.replace(/\n/g, " ") } : {}),
    ...(node.content ? { content: node.content.map(unwrapSoftBreaks) } : {}),
  };
}

function loadMarkdown(editor: Editor, markdown: string) {
  if (!editor.markdown) return;
  editor.commands.setContent(unwrapSoftBreaks(editor.markdown.parse(markdown)), { emitUpdate: false });
}

/**
 * WYSIWYG editor for a pending plan body. Serialization normalizes spacing,
 * so an editor whose content matches the loaded submission reports the
 * submitted bytes and leaves the artifact untouched.
 */
export default function PlanMarkdownEditor({
  value,
  baseMarkdown,
  dispatch,
}: {
  value: string;
  baseMarkdown: string;
  dispatch: (action: PlanDraftAction) => void;
}) {
  const { t } = useTranslation();
  const baseline = useRef<string | undefined>(undefined);
  const editor = useEditor({
    extensions: EXTENSIONS,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "plan-markdown prose-chat plan-markdown-editor",
        "aria-label": t("plan.documentEditor"),
        "data-testid": "plan-markdown-editor",
      },
    },
    onCreate: ({ editor }) => {
      loadMarkdown(editor, baseMarkdown);
      baseline.current = editor.getMarkdown();
      if (value !== baseMarkdown) loadMarkdown(editor, value);
    },
    onUpdate: ({ editor }) => {
      const markdown = editor.getMarkdown();
      dispatch({ type: "markdownSet", value: markdown === baseline.current ? baseMarkdown : markdown });
    },
  });

  useEffect(() => {
    if (editor && value === baseMarkdown && editor.getMarkdown() !== baseline.current) {
      loadMarkdown(editor, baseMarkdown);
    }
  }, [editor, value, baseMarkdown]);

  return <EditorContent editor={editor} />;
}
