ALTER TABLE `automation_runs` ADD `trigger` text DEFAULT 'schedule' NOT NULL;--> statement-breakpoint
ALTER TABLE `automations` ADD `check_script` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `automations` ADD `webhook_token_hash` text;--> statement-breakpoint
ALTER TABLE `automations` ADD `paused_reason` text;--> statement-breakpoint
ALTER TABLE `automations` ADD `resumed_at` text;--> statement-breakpoint
ALTER TABLE `pending_messages` ADD `check` text;