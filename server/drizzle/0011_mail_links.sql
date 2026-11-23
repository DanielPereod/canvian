-- Tareas vinculadas a hilos de correo (extensión del navegador, en Outlook).
CREATE TABLE `mail_links` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`thread` text NOT NULL,
	`subject` text,
	`subject_key` text,
	`url` text,
	`note_id` text NOT NULL,
	`block_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_mail_links` ON `mail_links` (`profile_id`,`thread`,`note_id`,`block_id`);--> statement-breakpoint
CREATE INDEX `idx_mail_links_subject` ON `mail_links` (`profile_id`,`subject_key`);--> statement-breakpoint
CREATE INDEX `idx_mail_links_task` ON `mail_links` (`note_id`,`block_id`);
