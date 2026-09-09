ALTER TABLE "access_code_redemptions" DROP CONSTRAINT "access_code_redemptions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "rate_limit_lookup_idx";--> statement-breakpoint
ALTER TABLE "access_code_redemptions" ADD CONSTRAINT "access_code_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limit_window_key" ON "rate_limit_events" USING btree ("bucket","subject","window_start");