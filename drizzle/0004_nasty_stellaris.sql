CREATE TABLE `period_awards` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`seat_id` text,
	`period_type` text NOT NULL,
	`period_key` text NOT NULL,
	`bonus_cents` integer NOT NULL,
	`winning_change_bps` integer NOT NULL,
	`awarded_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`seat_id`) REFERENCES `seats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `period_awards_game_period_unique` ON `period_awards` (`game_id`,`period_type`,`period_key`);--> statement-breakpoint
CREATE INDEX `period_awards_game_time_idx` ON `period_awards` (`game_id`,`awarded_at`);--> statement-breakpoint
ALTER TABLE `seats` ADD `bonus_cents` integer DEFAULT 0 NOT NULL;