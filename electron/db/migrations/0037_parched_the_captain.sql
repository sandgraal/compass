CREATE TABLE `documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text,
	`byte_size` integer,
	`sha256` text NOT NULL,
	`stored_path` text NOT NULL,
	`extracted_text` text,
	`page_count` integer,
	`doc_date` text,
	`category` text,
	`notes` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_sha256_unique` ON `documents` (`sha256`);--> statement-breakpoint
CREATE TABLE `document_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` integer NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_links_doc_target` ON `document_links` (`document_id`,`target_kind`,`target_id`);--> statement-breakpoint
CREATE VIRTUAL TABLE `documents_fts` USING fts5(
	title, extracted_text,
	content='documents', content_rowid='id',
	tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
	INSERT INTO documents_fts(rowid, title, extracted_text) VALUES (new.id, new.title, new.extracted_text);
END;--> statement-breakpoint
CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
	INSERT INTO documents_fts(documents_fts, rowid, title, extracted_text) VALUES('delete', old.id, old.title, old.extracted_text);
END;--> statement-breakpoint
CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
	INSERT INTO documents_fts(documents_fts, rowid, title, extracted_text) VALUES('delete', old.id, old.title, old.extracted_text);
	INSERT INTO documents_fts(rowid, title, extracted_text) VALUES (new.id, new.title, new.extracted_text);
END;
