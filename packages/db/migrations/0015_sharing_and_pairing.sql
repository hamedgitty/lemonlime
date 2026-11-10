CREATE TABLE `desktop_approvals` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `automations` ADD `secret_names` text;--> statement-breakpoint
ALTER TABLE `computers` ADD `sealed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `shared` integer DEFAULT false NOT NULL;