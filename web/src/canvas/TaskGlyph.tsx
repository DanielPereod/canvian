import type { TaskStatus } from '../api';

const LABEL: Record<TaskStatus, string> = { todo: 'Pendiente', doing: 'En curso', blocked: 'Bloqueada', done: 'Hecha' };

// Estado de una tarea. Con «Tareas que maduran» es una planta que crece
// (semilla → brote → flor); sin él, un círculo que se va llenando.
export function TaskGlyph({ status, ripe, onCycle }: { status: TaskStatus; ripe: boolean; onCycle: () => void }) {
  return (
    <button
      className={`task-glyph nodrag ${ripe ? 'ripe' : 'plain'} is-${status}`}
      title={`${LABEL[status]} · X para avanzar`}
      aria-label={LABEL[status]}
      onClick={(e) => {
        e.stopPropagation();
        onCycle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {ripe ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <g className="g-seed">
            <ellipse cx="12" cy="15" rx="3.2" ry="4.2" transform="rotate(-18 12 15)" />
            <path d="M11 11.5 q1.5 -1.8 3 -.6" />
          </g>
          <g className="g-sprout">
            <path d="M12 21 V11" />
            <path d="M12 14 C 8 14 6 11 6 8 C 9.5 8 12 10 12 14 Z" />
            <path d="M12 12 C 16 12 18 9 18 6 C 14.5 6 12 8 12 12 Z" />
          </g>
          <g className="g-flower">
            {[0, 72, 144, 216, 288].map((a) => (
              <ellipse key={a} cx="12" cy="6.6" rx="3" ry="4.4" transform={`rotate(${a} 12 12)`} />
            ))}
            <circle className="core" cx="12" cy="12" r="2.6" />
          </g>
          <path className="bar" d="M6.5 17.5 L17.5 6.5" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle className="ring" cx="12" cy="12" r="8" />
          <path className="half" d="M12 4 A8 8 0 0 1 12 20 Z" />
          <path className="tick" d="M8 12.4 l2.7 2.7 L16.2 9.4" />
          <path className="bar" d="M6.5 17.5 L17.5 6.5" />
        </svg>
      )}
    </button>
  );
}
