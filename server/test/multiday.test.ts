import { describe, expect, it } from 'vitest';
import { changeTask, newTaskItem, setToday, spans, tasksOf, type NoteRow } from '../src/doc/tasks.js';

const row = (lines: string[]): NoteRow => ({
  id: 'n1',
  kind: 'text',
  updatedAt: '2026-10-01T00:00:00Z',
  bodyJson: JSON.stringify({
    type: 'doc',
    content: [{ type: 'taskList', content: lines.map((text) => ({ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })) }],
  }),
});
const lines = (doc: unknown) => tasksOf({ id: 'n1', kind: 'text', updatedAt: 'x', bodyJson: JSON.stringify(doc) });

describe('multi-day tasks', () => {
  it('reads the start date (🛫) and leaves it out of the title', () => {
    const [t] = tasksOf(row(['Vacaciones 🛫 2026-10-15 📅 2026-10-16']));
    expect(t).toMatchObject({ title: 'Vacaciones', startAt: '2026-10-15', dueAt: '2026-10-16' });
    expect(spans(t)).toBe(true);
    expect(spans({ startAt: '2026-10-16', dueAt: '2026-10-16' })).toBe(false);
  });

  it('writes and removes the start date', () => {
    const r = row(['Viaje 📅 2026-10-20']);
    const [t] = tasksOf(r);
    const doc = changeTask(r, t, { startAt: '2026-10-18' });
    const [u] = lines(doc);
    expect(u).toMatchObject({ startAt: '2026-10-18', dueAt: '2026-10-20', title: 'Viaje' });
    const r2 = { ...r, bodyJson: JSON.stringify(doc) };
    const [v] = lines(changeTask(r2, u, { startAt: null, dueAt: '2026-10-21' }));
    expect(v).toMatchObject({ startAt: null, dueAt: '2026-10-21' });
    // Con el texto nuevo, la línea se escribe entera y conserva el inicio.
    const [w] = lines(changeTask(r2, u, { source: 'Viaje a Roma' }));
    expect(w).toMatchObject({ title: 'Viaje a Roma', startAt: '2026-10-18', dueAt: '2026-10-20' });
  });

  it('new items carry the start date', () => {
    const doc = { type: 'doc', content: [{ type: 'taskList', content: [newTaskItem('Congreso', { startAt: '2026-11-02', dueAt: '2026-11-04' })] }] };
    expect(lines(doc)[0]).toMatchObject({ title: 'Congreso', startAt: '2026-11-02', dueAt: '2026-11-04' });
  });

  it('a recurring multi-day task keeps its length', () => {
    setToday(() => '2026-10-05');
    const r = row(['Guardia 🔁 every week 🛫 2026-10-05 📅 2026-10-07']);
    const [t] = tasksOf(r);
    const [next, done] = lines(changeTask(r, t, { status: 'done' }));
    expect(next).toMatchObject({ status: 'todo', startAt: '2026-10-12', dueAt: '2026-10-14' });
    expect(done).toMatchObject({ status: 'done', startAt: '2026-10-05', dueAt: '2026-10-07' });
  });

  it('reads and writes times (⏰)', () => {
    const r = row(['Dentista ⏰ 9:30-10:15 📅 2026-10-06 #salud']);
    const [t] = tasksOf(r);
    expect(t).toMatchObject({ title: 'Dentista', startTime: '09:30', endTime: '10:15', dueAt: '2026-10-06', tags: ['salud'] });
    const [u] = lines(changeTask(r, t, { startTime: '11:00', endTime: '12:00' }));
    expect(u).toMatchObject({ startTime: '11:00', endTime: '12:00', title: 'Dentista' });
    const [v] = lines(changeTask(r, t, { startTime: null }));
    expect(v).toMatchObject({ startTime: null, endTime: null, dueAt: '2026-10-06' });
    const [w] = lines(changeTask(r, t, { source: 'Dentista nuevo' }));
    expect(w).toMatchObject({ title: 'Dentista nuevo', startTime: '09:30', endTime: '10:15' });
    const [x] = tasksOf(row(['Repite 🔁 every day ⏰ 08:00 📅 2026-10-06']));
    expect(x).toMatchObject({ repeat: 'every day', startTime: '08:00', endTime: null });
  });
});
