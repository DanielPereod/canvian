import { useState } from 'react';
import { MiniMap, useReactFlow, useViewport, type Node } from '@xyflow/react';
import { t } from '../../i18n';
import { cardTint } from './BoardMenu';

// Abajo a la izquierda, como en Figma o Miro: cuánto se ve acercado (pulsar
// el número vuelve al 100 %), acercar y alejar, y el minimapa del lienzo,
// que se abre y se cierra (y se recuerda en este navegador).

const MAP_KEY = 'canvian.boardMap';
const loadMap = () => {
  try {
    return localStorage.getItem(MAP_KEY) !== '0';
  } catch {
    return true;
  }
};

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const nodeColor = (n: Node) => {
  if (n.type === 'group') return 'transparent';
  const c = cardTint((n.data as { color?: string }).color);
  return c ? `color-mix(in oklab, ${c} 70%, var(--surface-1))` : 'var(--board-map-node)';
};

export function BoardNav({ hasNodes }: { hasNodes: boolean }) {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  const [map, setMap] = useState(loadMap);
  const toggle = () => {
    setMap(!map);
    try {
      localStorage.setItem(MAP_KEY, map ? '0' : '1');
    } catch {
      // Se recordará solo mientras esté abierto.
    }
  };
  return (
    <div className="board-nav">
      {map && hasNodes && (
        <MiniMap
          className="board-map surface-2"
          position="bottom-left"
          pannable
          zoomable
          nodeColor={nodeColor}
          nodeStrokeColor={(n) => (n.type === 'group' ? 'var(--line-strong)' : 'transparent')}
          nodeStrokeWidth={6}
          nodeBorderRadius={8}
          bgColor="transparent"
          maskColor="var(--board-map-mask)"
          maskStrokeColor="var(--accent-line, var(--line-strong))"
          maskStrokeWidth={1}
          ariaLabel={t('Minimapa')}
          style={{ width: 176, height: 116 }}
        />
      )}
      <div className="board-zoom surface-2" role="group" aria-label={t('Zoom')}>
        <button onClick={() => flow.zoomOut({ duration: 200 })} title={t('Alejar')} aria-label={t('Alejar')}>
          {icon('M6 12h12')}
        </button>
        <button className="board-zoom-pct" onClick={() => flow.zoomTo(1, { duration: 300 })} title={t('Volver al 100 %')}>
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => flow.zoomIn({ duration: 200 })} title={t('Acercar')} aria-label={t('Acercar')}>
          {icon('M6 12h12M12 6v12')}
        </button>
        {hasNodes && (
          <>
            <span className="board-tools-sep" />
            <button className={map ? 'is-on' : ''} onClick={toggle} title={map ? t('Ocultar el minimapa') : t('Ver el minimapa')} aria-label={t('Minimapa')} aria-pressed={map}>
              {icon('M4 6.5 9 4.5l6 2 5-2v13l-5 2-6-2-5 2zM9 4.5v13M15 6.5v13')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
