ALTER TABLE `games` ADD `period_bonuses_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `seats`
SET `cash_cents` = `cash_cents` - `bonus_cents`,
    `bonus_cents` = 0
WHERE `bonus_cents` <> 0;--> statement-breakpoint
DELETE FROM `period_awards`;
