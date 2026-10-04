import { describe, expect, it } from 'vitest';
import { changeTask, nextDate, nextParagraph, occurrences, parseRecur, recurText, setToday, tasksOf, type NoteRow } from '../src/doc/tasks.js';

const rule = (s: string) => {
  const r = parseRecur(s);
  if (!r) throw new Error(`no entiende ${s}`);
  return r;
};
const row = (lines: string[]): NoteRow => ({
  id: 'n1',
  kind: 'text',
  updatedAt: '2026-10-01T00:00:00Z',
  bodyJson: JSON.stringify({
    type: 'doc',
    content: [{ type: 'taskList', content: lines.map((text) => ({ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })) }],
  }),
});

describe('recurring rules', () => {
  it('reads Obsidian Tasks rules', () => {
    expect(rule('every day')).toMatchObject({ n: 1, unit: 'day' });
    expect(rule('every 3 days')).toMatchObject({ n: 3, unit: 'day' });
    expect(rule('every weekday')).toMatchObject({ unit: 'week', days: [1, 2, 3, 4, 5] });
    expect(rule('every Monday')).toMatchObject({ unit: 'week', days: [1] });
    expect(rule('every week on Monday, Thursday')).toMatchObject({ unit: 'week', days: [1, 4] });
    expect(rule('every 2 weeks')).toMatchObject({ n: 2, unit: 'week', days: [] });
    expect(rule('every month on the 15th')).toMatchObject({ unit: 'month', monthDay: 15 });
    expect(rule('every month on the last')).toMatchObject({ unit: 'month', monthDay: -1 });
    expect(rule('every year when done')).toMatchObject({ unit: 'year', whenDone: true });
    expect(parseRecur('cada lunes')).toBeNull();
    expect(parseRecur('every blue moon')).toBeNull();
    expect(recurText(rule('every week on thursday, monday'))).toBe('every week on Monday, Thursday');
    expect(recurText(rule('every month on the 2'))).toBe('every month on the 2nd');
  });

  it('finds the next date', () => {
    expect(nextDate(rule('every day'), '2026-10-04')).toBe('2026-10-05');
    expect(nextDate(rule('every 2 weeks'), '2026-10-04')).toBe('2026-10-18');
    // 2026-10-04 es domingo.
    expect(nextDate(rule('every weekday'), '2026-10-02')).toBe('2026-10-05');
    expect(nextDate(rule('every week on Monday, Thursday'), '2026-10-05')).toBe('2026-10-08');
    expect(nextDate(rule('every 2 weeks on Monday'), '2026-10-05')).toBe('2026-10-19');
    expect(nextDate(rule('every month'), '2026-01-31')).toBe('2026-02-28');
    expect(nextDate(rule('every month on the last'), '2026-02-28')).toBe('2026-03-31');
    expect(nextDate(rule('every month on the 15th'), '2026-10-04')).toBe('2026-10-15');
    expect(nextDate(rule('every year'), '2028-02-29')).toBe('2029-02-28');
    expect(occurrences(rule('every week'), '2026-10-04', '2026-10-26')).toEqual(['2026-10-11', '2026-10-18', '2026-10-25']);
  });

  it('reads the rule off the task', () => {
    const [t] = tasksOf(row(['Regar 🔁 every week 📅 2026-10-04 #casa']));
    expect(t).toMatchObject({ title: 'Regar', repeat: 'every week', dueAt: '2026-10-04', tags: ['casa'] });
  });

  it('adds the next one above when done', () => {
    setToday(() => '2026-10-06');
    const r = row(['Regar 🔁 every week 📅 2026-10-04 #casa', 'Otra']);
    const [t] = tasksOf(r);
    const doc = changeTask(r, t, { status: 'done' })!;
    const after = tasksOf({ ...r, bodyJson: JSON.stringify(doc), updatedAt: 'x' });
    expect(after.map((x) => [x.title, x.status, x.dueAt, x.doneAt])).toEqual([
      ['Regar', 'todo', '2026-10-11', null],
      ['Regar', 'done', '2026-10-04', '2026-10-06'],
      ['Otra', 'todo', null, null],
    ]);
    expect(after[0].repeat).toBe('every week');

    // «when done» cuenta desde hoy; sin fecha, también.
    const w = row(['Cortar el pelo 🔁 every 2 weeks when done 📅 2026-09-01']);
    const wd = changeTask(w, tasksOf(w)[0], { status: 'done' })!;
    expect(tasksOf({ ...w, bodyJson: JSON.stringify(wd), updatedAt: 'y' })[0].dueAt).toBe('2026-10-20');
    expect(nextParagraph({ type: 'paragraph', content: [{ type: 'text', text: 'Leer 🔁 every day ✅ 2026-10-06' }] })).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Leer 🔁 every day 📅 2026-10-07' }],
    });
  });

  it('sets and clears the rule', () => {
    const r = row(['Regar 📅 2026-10-04']);
    const set = changeTask(r, tasksOf(r)[0], { repeat: 'every month' })!;
    const r2 = { ...r, bodyJson: JSON.stringify(set), updatedAt: 'z' };
    expect(tasksOf(r2)[0]).toMatchObject({ title: 'Regar', repeat: 'every month', dueAt: '2026-10-04' });
    const cleared = changeTask(r2, tasksOf(r2)[0], { repeat: null })!;
    expect(JSON.stringify(cleared)).toContain('"Regar 📅 2026-10-04"');
  });
});
