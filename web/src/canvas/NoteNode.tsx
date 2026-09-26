import { memo, useMemo } from 'react';
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';
import { EditorContent, useEditor } from '@tiptap/react';
import { bodyToHtml, extensions, parseBody, titleFrom } from './editor';
import { useCanvasActions, type NoteData } from './context';

export type NoteNodeType = Node<NoteData, 'note'>;

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left];

function NoteEditor({ id, bodyJson }: { id: string; bodyJson: string | null }) {
  const { saveContent, finishEditing } = useCanvasActions();

  const editor = useEditor({
    extensions,
    content: parseBody(bodyJson) ?? '',
    autofocus: 'end',
    // Enfocar en cuanto se crea para no perder las primeras teclas.
    onCreate: ({ editor }) => editor.commands.focus('end'),
    editorProps: {
      attributes: { class: 'note-body prose' },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Escape') {
          finishEditing(id);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      const bodyText = editor.getText({ blockSeparator: '\n' });
      saveContent(id, { bodyJson: JSON.stringify(editor.getJSON()), bodyText, title: titleFrom(bodyText) });
    },
    onBlur: () => finishEditing(id),
  });

  return <EditorContent editor={editor} className="nodrag nopan nowheel cursor-text" />;
}

function NoteNodeView({ id, data, selected }: NodeProps<NoteNodeType>) {
  const { editingId, startEditing, resized } = useCanvasActions();
  const editing = editingId === id;
  const html = useMemo(() => bodyToHtml(data.bodyJson), [data.bodyJson]);

  return (
    <div
      className={`note surface-1${selected ? ' selected' : ''}${editing ? ' editing' : ''}${data.h ? ' fixed' : ''}`}
      onDoubleClick={(e) => {
        e.stopPropagation();
        startEditing(id);
      }}
    >
      <NodeResizer
        isVisible={selected && !editing}
        minWidth={160}
        minHeight={56}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeEnd={(_, p) => resized(id, p)}
      />
      {SIDES.map((side) => (
        <Handle key={side} id={side} type="source" position={side} className="handle" />
      ))}
      {editing ? (
        <NoteEditor id={id} bodyJson={data.bodyJson} />
      ) : html && data.bodyText?.trim() ? (
        <div className="note-body prose" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="note-body empty">Nota vacía</div>
      )}
    </div>
  );
}

export const NoteNode = memo(NoteNodeView);
