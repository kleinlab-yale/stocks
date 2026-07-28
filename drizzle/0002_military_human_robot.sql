CREATE TABLE `portfolio_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`seat_id` text NOT NULL,
	`bucket_start` integer NOT NULL,
	`after_tax_cents` integer NOT NULL,
	`captured_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`seat_id`) REFERENCES `seats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_snapshots_seat_bucket_unique` ON `portfolio_snapshots` (`seat_id`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `portfolio_snapshots_game_time_idx` ON `portfolio_snapshots` (`game_id`,`captured_at`);