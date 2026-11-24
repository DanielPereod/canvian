-- Cuadernos: aprender un tema desde cero con la IA. Un cuaderno por materia,
-- dividido en temas; cada tema guarda su sesión con el tutor, sus fuentes y
-- sus tarjetas de repaso (FSRS). Las notas que escribe la persona al aprender
-- son notas normales de la biblioteca: el tema solo apunta a ellas.
CREATE TABLE `notebooks` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`title` text NOT NULL,
	`goal` text,
	`level` text,
	`color` text,
	`status` text DEFAULT 'diagnostico' NOT NULL,
	`diagnosis` text DEFAULT '[]' NOT NULL,
	`source_mode` text DEFAULT 'auto' NOT NULL,
	`folder_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_notebooks_profile` ON `notebooks` (`profile_id`,`position`);--> statement-breakpoint
CREATE TABLE `nb_topics` (
	`id` text PRIMARY KEY NOT NULL,
	`notebook_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pendiente' NOT NULL,
	`stage` text,
	`gaps` text DEFAULT '[]' NOT NULL,
	`solid` text DEFAULT '[]' NOT NULL,
	`lesson` text,
	`brief` text,
	`note_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`notebook_id`) REFERENCES `notebooks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_nb_topics_notebook` ON `nb_topics` (`notebook_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_nb_topics_note` ON `nb_topics` (`note_id`);--> statement-breakpoint
CREATE TABLE `nb_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`notebook_id` text NOT NULL,
	`topic_id` text,
	`kind` text DEFAULT 'web' NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`note_id` text,
	`why` text,
	`origin` text DEFAULT 'manual' NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`removed` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`notebook_id`) REFERENCES `notebooks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`topic_id`) REFERENCES `nb_topics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_nb_sources_notebook` ON `nb_sources` (`notebook_id`,`topic_id`);--> statement-breakpoint
CREATE TABLE `nb_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`role` text NOT NULL,
	`stage` text,
	`body` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `nb_topics`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_nb_messages_topic` ON `nb_messages` (`topic_id`,`position`);--> statement-breakpoint
CREATE TABLE `nb_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`notebook_id` text NOT NULL,
	`topic_id` text,
	`kind` text DEFAULT 'dato' NOT NULL,
	`front` text NOT NULL,
	`back` text NOT NULL,
	`due` text NOT NULL,
	`stability` real DEFAULT 0 NOT NULL,
	`difficulty` real DEFAULT 0 NOT NULL,
	`scheduled_days` integer DEFAULT 0 NOT NULL,
	`learning_steps` integer DEFAULT 0 NOT NULL,
	`reps` integer DEFAULT 0 NOT NULL,
	`lapses` integer DEFAULT 0 NOT NULL,
	`state` integer DEFAULT 0 NOT NULL,
	`last_review` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`notebook_id`) REFERENCES `notebooks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`topic_id`) REFERENCES `nb_topics`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_nb_cards_due` ON `nb_cards` (`notebook_id`,`due`);--> statement-breakpoint
CREATE TABLE `nb_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`rating` integer NOT NULL,
	`confidence` integer,
	`answer` text,
	`reviewed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `nb_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_nb_reviews_card` ON `nb_reviews` (`card_id`,`reviewed_at`);
