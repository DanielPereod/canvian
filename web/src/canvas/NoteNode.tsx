import { memo, useCallback, useMemo, type CSSProperties } from 'react';
import { Handle, NodeResizer, Position, useStore, type Node, type NodeProps, type ReactFlowState } from '@xyflow/react';
import { EditorContent, useEditor } from '@tiptap/react';
import { bodyToHtml, extensions, parseBody, titleFrom } from './editor';
import { useCanvasActions, type NoteData } from './context';
import { TaskGlyph } from './TaskGlyph';
import { NoteChips } from './NoteChips';
import { useExperiments } from '../lab/experiments';

const DAY = 86_400_000;

// 0 si la tocaste hoy, 1 si lleva un mes o más sin cambios.
function ageOf(updatedAt: string | undefined, now: number) {
  if (!updatedAt) return 0;
  const days = (now - Date.parse(updatedAt)) / DAY;
  return Math.min(1, Math.max(0, (days - 1) / 29));
}

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
  const { editingId, startEditing, resized, cycleStatus, lit, defs, openInspector } = useCanvasActions();
  const exp = useExperiments();
  const editing = editingId === id;
  const html = useMemo(() => bodyToHtml(data.bodyJson), [data.bodyJson]);
  const degree = useStore(
    useCallback((s: ReactFlowState) => s.edges.reduce((c, e) => c + (e.source === id || e.target === id ? 1 : 0), 0), [id]),
  );
  const task = data.kind === 'task';
  const status = data.status ?? 'todo';
  const age = useMemo(() => ageOf(data.updatedAt, Date.now()), [data.updatedAt]);
  const lamp = lit ? (lit.has(id) ? ' lit' : ' shadowed') : '';

  const vars = {
    '--age': exp.memoria ? age.toFixed(3) : 0,
    '--bloom': exp.florecen ? (Math.min(degree, 6) / 6).toFixed(3) : 0,
  } as CSSProperties;

  return (
    <div
      className={`note surface-1${selected ? ' selected' : ''}${editing ? ' editing' : ''}${data.h ? ' fixed' : ''}${task ? ` task is-${status}` : ''}${lamp}`}
      style={vars}
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
      {task && <TaskGlyph status={status} ripe={exp.maduran} onCycle={() => cycleStatus(id)} />}
      <span className="star-label" aria-hidden="true">
        {data.title || 'Nota'}
      </span>
      {editing ? (
        <NoteEditor id={id} bodyJson={data.bodyJson} />
      ) : html && data.bodyText?.trim() ? (
        <div className="note-body prose" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="note-body empty">Nota vacía</div>
      )}
      {!editing && <NoteChips note={data} defs={defs} onOpen={() => openInspector(id)} />}
    </div>
  );
}

export const NoteNode = memo(NoteNodeView);
