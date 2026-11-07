CREATE TABLE `workspace_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`accepted_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "workspace_invites_role" CHECK("workspace_invites"."role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invites_token_idx` ON `workspace_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `workspace_invites_workspace_idx` ON `workspace_invites` (`workspace_id`);