CREATE TABLE `claude_proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proposal_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`source` text DEFAULT 'claude-mcp' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`ingested_at` integer NOT NULL,
	`resolved_at` integer,
	`error` text,
	`result_ref` text,
	`cleared_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claude_proposals_proposal_id_unique` ON `claude_proposals` (`proposal_id`);