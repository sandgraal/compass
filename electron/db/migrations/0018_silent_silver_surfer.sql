CREATE VIRTUAL TABLE records_fts USING fts5(
  title, body, payload,
  content='records', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(rowid, title, body, payload) VALUES (new.id, new.title, new.body, new.payload);
END;--> statement-breakpoint
CREATE TRIGGER records_ad AFTER DELETE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, body, payload) VALUES('delete', old.id, old.title, old.body, old.payload);
END;--> statement-breakpoint
CREATE TRIGGER records_au AFTER UPDATE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, body, payload) VALUES('delete', old.id, old.title, old.body, old.payload);
  INSERT INTO records_fts(rowid, title, body, payload) VALUES (new.id, new.title, new.body, new.payload);
END;
