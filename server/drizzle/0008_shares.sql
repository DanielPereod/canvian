-- Notas públicas: el enlace para compartir una nota (y, si se quiere, sus
-- hijas), con contraseña opcional.
CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`password_hash` text,
	`scope` text DEFAULT 'note' NOT NULL,
	`child_ids` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shares_note_id_unique` ON `shares` (`note_id`);
