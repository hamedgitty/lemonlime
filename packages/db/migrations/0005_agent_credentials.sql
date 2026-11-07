CREATE TABLE `agent_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`agent` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`ciphertext` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_credentials_user_agent_name_idx` ON `agent_credentials` (`user_id`,`agent`,`name`);