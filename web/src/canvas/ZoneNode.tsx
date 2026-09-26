import { memo, useState } from 'react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import { useCanvasActions, type NoteData } from './context';

export type ZoneNodeType = Node<NoteData, 'zone'>;

function ZoneNodeView({ id, data, selected }: NodeProps<ZoneNodeType>) {
  const { renameZone, resized } = useCanvasActions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.title ?? '');

  const commit = () => {
    setEditing(false);
    const title = draft.trim();
    if (title !== (data.title ?? '')) renameZone(id, title);
  };

  return (
    <div className={`zone${selected ? ' selected' : ''}`}>
      <NodeResizer
        isVisible={selected}
        minWidth={200}
        minHeight={140}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeEnd={(_, p) => resized(id, p)}
      />
      <div
        className="zone-header"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(data.title ?? '');
          setEditing(true);
        }}
      >
        {editing ? (
          <input
            id={`zone-title-${id}`}
            className="zone-title-input nodrag"
            autoFocus
            value={draft}
            placeholder="Nombre de la zona"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <span className={data.title ? 'zone-title' : 'zone-title muted'}>{data.title || 'Zona sin nombre'}</span>
        )}
      </div>
      <div className="zone-body" />
    </div>
  );
}

export const ZoneNode = memo(ZoneNodeView);
