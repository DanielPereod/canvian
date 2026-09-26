import { memo } from 'react';
import type { Node, NodeProps } from '@xyflow/react';

export type ColumnData = { title: string; count: number; active: boolean; height: number };
export type ColumnNodeType = Node<ColumnData, 'column'>;

// Cabecera y carril de una columna del modo «reordenar».
function ColumnNodeView({ data }: NodeProps<ColumnNodeType>) {
  return (
    <div className={`lens-column${data.active ? ' active' : ''}`} style={{ height: data.height }}>
      <div className="lens-column-head">
        <span className="lens-column-title">{data.title}</span>
        <span className="lens-column-count">{data.count}</span>
      </div>
    </div>
  );
}

export const ColumnNode = memo(ColumnNodeView);
