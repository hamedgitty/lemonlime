CREATE TABLE `computers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`platform` text DEFAULT 'other' NOT NULL,
	`phone_access` integer DEFAULT false NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`threads` text DEFAULT '[]' NOT NULL,
	`last_seen_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "computers_name_length" CHECK(length("computers"."name") between 1 and 100),
	CONSTRAINT "computers_platform" CHECK("computers"."platform" in ('mac', 'windows', 'linux', 'other'))
);
--> statement-breakpoint
CREATE INDEX `computers_user_idx` ON `computers` (`user_id`);