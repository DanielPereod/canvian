-- Búsqueda de texto completo sobre el título y el texto plano de las notas.
CREATE VIRTUAL TABLE `notes_fts` USING fts5(title, body_text, content='notes', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `notes_fts_ai` AFTER INSERT ON `notes` BEGIN
  INSERT INTO notes_fts(rowid, title, body_text) VALUES (new.rowid, new.title, new.body_text);
END;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_ad` AFTER DELETE ON `notes` BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body_text) VALUES ('delete', old.rowid, old.title, old.body_text);
END;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_au` AFTER UPDATE OF title, body_text ON `notes` BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body_text) VALUES ('delete', old.rowid, old.title, old.body_text);
  INSERT INTO notes_fts(rowid, title, body_text) VALUES (new.rowid, new.title, new.body_text);
END;
