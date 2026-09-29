import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  real,
  integer,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

// Clave/valor para ajustes de la instancia (hash de la contraseña, etc.).
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(), // sha256 del token de la cookie
  createdAt: text('created_at').notNull().default(now),
  expiresAt: text('expires_at').notNull(),
});

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color'),
  icon: text('icon'),
  position: integer('position').notNull().default(0),
  createdAt: text('created_at').notNull().default(now),
});

export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // text | task | quick | canvas | link | image | checklist | code | zone
    title: text('title'),
    bodyJson: text('body_json'), // documento Tiptap
    bodyText: text('body_text'), // texto plano para la búsqueda
    props: text('props').notNull().default('{}'),
    x: real('x').notNull().default(0),
    y: real('y').notNull().default(0),
    w: real('w'),
    h: real('h'),
    z: integer('z').notNull().default(0),
    zoneId: text('zone_id'),
    status: text('status'), // todo | doing | blocked | done (solo tareas)
    priority: integer('priority'),
    dueAt: text('due_at'),
    doneAt: text('done_at'),
    archivedAt: text('archived_at'), // archivada: oculta salvo que se pidan las ocultas
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    index('idx_notes_profile').on(t.profileId, t.deletedAt),
    index('idx_notes_tasks')
      .on(t.profileId, t.status, t.dueAt)
      .where(sql`${t.kind} = 'task'`),
  ],
);

export const propertyDefs = sqliteTable(
  'property_defs',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(), // text | number | select | multi_select | date | checkbox | url
    options: text('options').notNull().default('[]'),
    appliesTo: text('applies_to').notNull().default('task'), // task | all
    position: integer('position').notNull().default(0),
  },
  (t) => [uniqueIndex('uq_property_defs_name').on(t.profileId, t.name)],
);

export const edges = sqliteTable(
  'edges',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    fromId: text('from_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    toId: text('to_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    label: text('label'),
    kind: text('kind').notNull().default('link'), // link | blocks
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('idx_edges_from').on(t.fromId), index('idx_edges_to').on(t.toId)],
);

export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
  },
  (t) => [uniqueIndex('uq_tags_name').on(t.profileId, t.name)],
);

export const noteTags = sqliteTable(
  'note_tags',
  {
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.noteId, t.tagId] })],
);

export const lenses = sqliteTable('lenses', {
  id: text('id').primaryKey(),
  profileId: text('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  query: text('query').notNull(),
  mode: text('mode').notNull().default('dim'), // dim | hide | arrange
  slot: integer('slot'),
});

export const viewports = sqliteTable('viewports', {
  profileId: text('profile_id')
    .primaryKey()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  x: real('x').notNull().default(0),
  y: real('y').notNull().default(0),
  zoom: real('zoom').notNull().default(1),
});
