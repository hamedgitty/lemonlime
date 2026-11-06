CREATE TABLE `access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "access_tokens_name_length" CHECK(length("access_tokens"."name") between 1 and 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_tokens_token_hash_idx` ON `access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `access_tokens_user_idx` ON `access_tokens` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `sandbox_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`sandbox_id` text NOT NULL,
	`size` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`runtime_seconds` integer NOT NULL,
	`end_reason` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sandbox_runs_size" CHECK("sandbox_runs"."size" in ('small', 'large')),
	CONSTRAINT "sandbox_runs_runtime" CHECK("sandbox_runs"."runtime_seconds" >= 0),
	CONSTRAINT "sandbox_runs_end_reason" CHECK("sandbox_runs"."end_reason" in ('idle', 'user', 'policy', 'error', 'replaced'))
);
--> statement-breakpoint
CREATE INDEX `sandbox_runs_thread_idx` ON `sandbox_runs` (`thread_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `sandbox_runs_workspace_idx` ON `sandbox_runs` (`workspace_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by` text,
	`title` text DEFAULT '' NOT NULL,
	`agent` text NOT NULL,
	`repo` text NOT NULL,
	`branch` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`sandbox_size` text DEFAULT 'small' NOT NULL,
	`sandbox_provider` text,
	`sandbox_id` text,
	`runner_url` text,
	`latest_seq` integer DEFAULT 0 NOT NULL,
	`idle_since` text,
	`running_since` text,
	`last_heartbeat_at` text,
	`initial_prompt` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "threads_title_length" CHECK(length("threads"."title") <= 200),
	CONSTRAINT "threads_mode" CHECK("threads"."mode" in ('local', 'cloud')),
	CONSTRAINT "threads_status" CHECK("threads"."status" in ('provisioning', 'idle', 'running', 'paused', 'stopped', 'failed')),
	CONSTRAINT "threads_sandbox_size" CHECK("threads"."sandbox_size" in ('small', 'large')),
	CONSTRAINT "threads_latest_seq" CHECK("threads"."latest_seq" >= 0)
);
--> statement-breakpoint
CREATE INDEX `threads_workspace_updated_idx` ON `threads` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `threads_running_idx` ON `threads` (`running_since`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_members_role" CHECK("workspace_members"."role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`personal` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "workspaces_name_length" CHECK(length("workspaces"."name") between 1 and 200)
);
