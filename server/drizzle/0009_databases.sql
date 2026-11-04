-- Bases de datos: tablas de verdad (no notas), con columnas tipadas y
-- relaciones entre ellas. Los valores de cada fila van en JSON, por id de
-- columna; las relaciones, en db_links (una fila por enlace).
CREATE TABLE `db_tables` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_db_tables_profile` ON `db_tables` (`profile_id`);
--> statement-breakpoint
CREATE TABLE `db_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`table_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`table_id`) REFERENCES `db_tables`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_db_columns_table` ON `db_columns` (`table_id`);
--> statement-breakpoint
CREATE TABLE `db_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`table_id` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`table_id`) REFERENCES `db_tables`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_db_rows_table` ON `db_rows` (`table_id`, `position`);
--> statement-breakpoint
CREATE TABLE `db_links` (
	`column_id` text NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`column_id`, `from_id`, `to_id`),
	FOREIGN KEY (`column_id`) REFERENCES `db_columns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_id`) REFERENCES `db_rows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_id`) REFERENCES `db_rows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_db_links_to` ON `db_links` (`column_id`, `to_id`);
