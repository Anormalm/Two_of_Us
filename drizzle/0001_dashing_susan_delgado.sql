CREATE TABLE `workspace_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`pending_partner_name` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `profiles` ADD `custom_name` text;