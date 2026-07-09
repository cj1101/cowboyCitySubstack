"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";

interface TipTapEditorProps {
  content: string;
  onChange: (html: string) => void;
  placeholder?: string;
  editable?: boolean;
}

export function TipTapEditor({
  content,
  onChange,
  placeholder = "Write your lore…",
  editable = true,
}: TipTapEditorProps) {
  const editor = useEditor({
    extensions: [StarterKit],
    content,
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          "prose prose-invert max-w-none min-h-[200px] px-4 py-3 focus:outline-none text-text-light",
      },
    },
    onUpdate: ({ editor: ed }) => {
      onChange(ed.getHTML());
    },
  });

  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content, { emitUpdate: false });
    }
  }, [content, editor]);

  if (!editor) {
    return (
      <div className="rounded border border-accent-gold/40 bg-darker-brown/80 min-h-[200px] flex items-center justify-center text-text-muted">
        Loading editor…
      </div>
    );
  }

  return (
    <div className="rounded border border-accent-gold/40 bg-darker-brown/80 overflow-hidden">
      {editable && (
        <div className="flex flex-wrap gap-1 p-2 border-b border-accent-gold/20 bg-glass-bg/50">
          <ToolbarButton
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
            label="B"
            title="Bold"
            className="font-bold"
          />
          <ToolbarButton
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            label="I"
            title="Italic"
            className="italic"
          />
          <ToolbarButton
            active={editor.isActive("heading", { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            label="H2"
            title="Heading"
          />
          <ToolbarButton
            active={editor.isActive("heading", { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            label="H3"
            title="Subheading"
          />
          <ToolbarButton
            active={editor.isActive("bulletList")}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            label="• List"
            title="Bullet list"
          />
          <ToolbarButton
            active={editor.isActive("orderedList")}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            label="1. List"
            title="Numbered list"
          />
          <ToolbarButton
            active={editor.isActive("blockquote")}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            label="Quote"
            title="Blockquote"
          />
        </div>
      )}
      <EditorContent editor={editor} />
      {editable && !editor.getText().trim() && (
        <p className="pointer-events-none absolute mt-[-180px] ml-4 text-text-muted/60 text-sm">
          {placeholder}
        </p>
      )}
    </div>
  );
}

function ToolbarButton({
  active,
  onClick,
  label,
  title,
  className = "",
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`px-2.5 py-1 rounded text-sm transition-colors ${
        active
          ? "bg-accent-gold text-darker-brown"
          : "text-text-muted hover:text-accent-gold hover:bg-primary-brown/50"
      } ${className}`}
    >
      {label}
    </button>
  );
}

export function TipTapContent({ html }: { html: string }) {
  return (
    <div
      className="prose prose-invert max-w-none text-text-light [&_a]:text-accent-gold [&_blockquote]:border-accent-gold/40"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
