CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host_token_hash` text NOT NULL,
	`status` text DEFAULT 'lobby' NOT NULL,
	`starting_cash_cents` integer NOT NULL,
	`tax_rate_bps` integer NOT NULL,
	`duration_days` integer NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ends_at` integer,
	`ended_at` integer
);
--> statement-breakpoint
CREATE TABLE `lots` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`seat_id` text NOT NULL,
	`symbol` text NOT NULL,
	`acquired_at` integer NOT NULL,
	`original_shares_micros` integer NOT NULL,
	`remaining_shares_micros` integer NOT NULL,
	`remaining_basis_cents` integer NOT NULL,
	`source_trade_id` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`seat_id`) REFERENCES `seats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_trade_id`) REFERENCES `trades`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lots_seat_symbol_idx` ON `lots` (`seat_id`,`symbol`,`acquired_at`);--> statement-breakpoint
CREATE TABLE `seats` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`seat_number` integer NOT NULL,
	`invite_token_hash` text NOT NULL,
	`player_name` text,
	`joined_at` integer,
	`cash_cents` integer NOT NULL,
	`realized_net_cents` integer DEFAULT 0 NOT NULL,
	`tax_reserve_cents` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seats_game_number_unique` ON `seats` (`game_id`,`seat_number`);--> statement-breakpoint
CREATE INDEX `seats_game_idx` ON `seats` (`game_id`);--> statement-breakpoint
CREATE INDEX `seats_invite_hash_idx` ON `seats` (`invite_token_hash`);--> statement-breakpoint
CREATE TABLE `trades` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`seat_id` text NOT NULL,
	`side` text NOT NULL,
	`symbol` text NOT NULL,
	`shares_micros` integer NOT NULL,
	`price_cents` integer NOT NULL,
	`gross_cents` integer NOT NULL,
	`basis_cents` integer NOT NULL,
	`realized_gain_cents` integer NOT NULL,
	`deferred_wash_loss_cents` integer DEFAULT 0 NOT NULL,
	`tax_delta_cents` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`seat_id`) REFERENCES `seats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trades_game_idx` ON `trades` (`game_id`);--> statement-breakpoint
CREATE INDEX `trades_seat_idx` ON `trades` (`seat_id`);--> statement-breakpoint
CREATE TABLE `wash_losses` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`seat_id` text NOT NULL,
	`symbol` text NOT NULL,
	`remaining_shares_micros` integer NOT NULL,
	`remaining_loss_cents` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`seat_id`) REFERENCES `seats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `wash_losses_lookup_idx` ON `wash_losses` (`seat_id`,`symbol`,`expires_at`);