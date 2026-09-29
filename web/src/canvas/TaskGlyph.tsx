import type { TaskStatus } from '../api';

const LABEL: Record<TaskStatus, string> = { todo: 'Pendiente', doing: 'En curso', blocked: 'Bloqueada', done: 'Hecha' };

// Estado de una tarea: un círculo que se va llenando.
export function TaskGlyph({ status, onCycle }: { status: TaskStatus; onCycle: () => void }) {
  return (
    <button
      className={`task-glyph nodrag is-${status}`}
      title={`${LABEL[status]} · X para avanzar`}
      aria-label={LABEL[status]}
      onClick={(e) => {
        e.stopPropagation();
        onCycle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="ring" cx="12" cy="12" r="8" />
        <path className="half" d="M12 4 A8 8 0 0 1 12 20 Z" />
        <path className="tick" d="M8 12.4 l2.7 2.7 L16.2 9.4" />
        <path className="bar" d="M6.5 17.5 L17.5 6.5" />
      </svg>
    </button>
  );
}
