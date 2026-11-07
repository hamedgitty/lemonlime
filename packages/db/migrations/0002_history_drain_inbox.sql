CREATE TABLE `pending_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` text NOT NULL,
	`client_msg_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_messages_thread_msg_idx` ON `pending_messages` (`thread_id`,`client_msg_id`);--> statement-breakpoint
ALTER TABLE `threads` ADD `history_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `background` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `drain_requested_at` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `drained_at` text;