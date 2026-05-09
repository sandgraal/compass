CREATE TABLE `knowledge_suggestions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proposed_at` integer NOT NULL,
	`source` text NOT NULL,
	`source_id` text,
	`target_path` text NOT NULL,
	`kind` text NOT NULL,
	`proposed_content` text NOT NULL,
	`context` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewed_at` integer
);
