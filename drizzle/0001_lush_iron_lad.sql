CREATE TABLE `quote_cache` (
	`symbol` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`price_cents` integer NOT NULL,
	`previous_close_cents` integer,
	`quoted_at` integer NOT NULL,
	`source` text NOT NULL,
	`updated_at` integer NOT NULL
);
