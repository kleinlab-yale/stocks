CREATE TABLE `dividend_event_cache` (
	`symbol` text PRIMARY KEY NOT NULL,
	`payload_json` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dividend_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`seat_id` text NOT NULL,
	`symbol` text NOT NULL,
	`ex_date` text NOT NULL,
	`payment_date` text NOT NULL,
	`shares_micros` integer NOT NULL,
	`amount_per_share_micros` integer NOT NULL,
	`gross_cents` integer NOT NULL,
	`tax_cents` integer NOT NULL,
	`credited_at` integer,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`seat_id`) REFERENCES `seats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dividend_payments_game_seat_event_unique` ON `dividend_payments` (`game_id`,`seat_id`,`symbol`,`ex_date`,`payment_date`);--> statement-breakpoint
CREATE INDEX `dividend_payments_game_time_idx` ON `dividend_payments` (`game_id`,`credited_at`);--> statement-breakpoint
ALTER TABLE `games` ADD `dividends_enabled_at` integer;--> statement-breakpoint
UPDATE `games`
SET `dividends_enabled_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `id` = 'b42e9743-1f0c-4957-ad5c-83d490e12f65'
  AND `name` = '1st Klein Millionaire'
  AND `dividends_enabled_at` IS NULL;--> statement-breakpoint
ALTER TABLE `seats` ADD `dividend_income_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `seats` ADD `dividend_tax_cents` integer DEFAULT 0 NOT NULL;
