CREATE TABLE `workspace_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`setup_script` text DEFAULT '' NOT NULL,
	`strip_coauthors` integer DEFAULT false NOT NULL,
	`retry_max_wait_minutes` integer DEFAULT 0 NOT NULL,
	`auto_delete_days` integer,
	`skills` text DEFAULT '[]' NOT NULL,
	`updated_by` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `reviewed_at` text;