CREATE TABLE `github_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_login` text NOT NULL,
	`linked_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`linked_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `github_installations_workspace_idx` ON `github_installations` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `threads` ADD `pull_request_url` text;