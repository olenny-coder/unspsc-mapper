-- UNSPSC Spend Categorizer — initial schema
-- Target: Neon Postgres (16+). Safe to re-run: every object uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "suppliers" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL,
  "normalized_name" text NOT NULL,
  "domain" text,
  "industry" text,
  "naics" text,
  "sic" text,
  "description" text,
  "country" text,
  "total_amount" numeric(18, 2),
  "transaction_count" integer DEFAULT 0 NOT NULL,
  "currency" text DEFAULT 'USD' NOT NULL,
  "parent_id" integer,
  "parent_name" text,
  "parent_domain" text,
  "is_parent" boolean DEFAULT false NOT NULL,
  "parent_source" text,
  "parent_confidence" numeric(3, 2),
  "enriched_at" timestamptz,
  "enrich_attempts" integer DEFAULT 0 NOT NULL,
  "last_enrich_error" text,
  "enrich_fingerprint" text,
  "stale" boolean DEFAULT false NOT NULL,
  "stale_reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_name_key" ON "suppliers" ("name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_normalized_name_key" ON "suppliers" ("normalized_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppliers_parent_id_idx" ON "suppliers" ("parent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppliers_domain_idx" ON "suppliers" ("domain");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppliers_stale_idx" ON "suppliers" ("stale", "enriched_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppliers_is_parent_idx" ON "suppliers" ("is_parent");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "suppliers"
    ADD CONSTRAINT "suppliers_parent_id_suppliers_id_fk"
    FOREIGN KEY ("parent_id") REFERENCES "suppliers"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "unspsc_codes" (
  "code" char(8) PRIMARY KEY,
  "segment" text,
  "segment_code" char(2),
  "family" text,
  "family_code" char(4),
  "class" text,
  "class_code" char(6),
  "commodity" text NOT NULL,
  "description" text,
  "search_text" text,
  "version" text DEFAULT 'v26.0801' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unspsc_codes_segment_code_idx" ON "unspsc_codes" ("segment_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unspsc_codes_family_code_idx" ON "unspsc_codes" ("family_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unspsc_codes_search_text_idx" ON "unspsc_codes" USING gin (to_tsvector('english', coalesce("search_text", '')));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "classifications" (
  "id" serial PRIMARY KEY,
  "supplier_id" integer NOT NULL,
  "unspsc_code" char(8) NOT NULL,
  "confidence" numeric(3, 2) NOT NULL,
  "reasoning" text,
  "llm_model" text,
  "alternatives" jsonb,
  "inherited_from_parent" boolean DEFAULT false NOT NULL,
  "inherited_from_supplier_id" integer,
  "reviewed" boolean DEFAULT false NOT NULL,
  "corrected_code" char(8),
  "corrected_by" text,
  "corrected_at" timestamptz,
  "superseded" boolean DEFAULT false NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "classifications_supplier_id_idx" ON "classifications" ("supplier_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "classifications_current_idx" ON "classifications" ("supplier_id", "superseded");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "classifications_unspsc_code_idx" ON "classifications" ("unspsc_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "classifications_reviewed_idx" ON "classifications" ("reviewed", "confidence");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "classifications"
    ADD CONSTRAINT "classifications_supplier_id_suppliers_id_fk"
    FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "corrections" (
  "id" serial PRIMARY KEY,
  "supplier_id" integer NOT NULL,
  "classification_id" integer,
  "original_code" char(8),
  "corrected_code" char(8) NOT NULL,
  "reason" text,
  "corrected_by" text NOT NULL,
  "applied_to_subsidiaries" boolean DEFAULT false NOT NULL,
  "affected_supplier_ids" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corrections_supplier_id_idx" ON "corrections" ("supplier_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corrections_created_at_idx" ON "corrections" ("created_at");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "corrections"
    ADD CONSTRAINT "corrections_supplier_id_suppliers_id_fk"
    FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "enrichment_cache" (
  "id" serial PRIMARY KEY,
  "supplier_name" text NOT NULL,
  "cache_key" text NOT NULL,
  "provider" text NOT NULL,
  "domain" text,
  "payload" jsonb,
  "raw_response" jsonb,
  "credits_used" integer DEFAULT 0 NOT NULL,
  "hit_count" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "enrichment_cache_cache_key_key" ON "enrichment_cache" ("cache_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_cache_supplier_name_idx" ON "enrichment_cache" ("supplier_name");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" serial PRIMARY KEY,
  "entity" text NOT NULL,
  "entity_id" integer,
  "action" text NOT NULL,
  "details" jsonb,
  "actor" text DEFAULT 'system' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_entity_idx" ON "audit_log" ("entity", "entity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_created_at_idx" ON "audit_log" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_action_idx" ON "audit_log" ("action");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "reports" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL,
  "format" text NOT NULL,
  "filters" jsonb,
  "row_count" integer DEFAULT 0 NOT NULL,
  "size_bytes" integer DEFAULT 0 NOT NULL,
  "generated_by" text DEFAULT 'system' NOT NULL,
  "blob" bytea,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_created_at_idx" ON "reports" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_format_idx" ON "reports" ("format");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_settings" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "confidence_threshold" numeric(3, 2) DEFAULT '0.70' NOT NULL,
  "model_strategy" text DEFAULT 'tiered' NOT NULL,
  "accurate_model" text DEFAULT 'llama-3.3-70b-versatile' NOT NULL,
  "bulk_model" text DEFAULT 'llama-3.1-8b-instant' NOT NULL,
  "parent_detection_enabled" boolean DEFAULT true NOT NULL,
  "enrichment_enabled" boolean DEFAULT true NOT NULL,
  "enrich_provider" text DEFAULT 'companyenrich' NOT NULL,
  "enrich_api_key_masked" text,
  "groq_api_key_masked" text,
  "sync_enabled" boolean DEFAULT true NOT NULL,
  "sync_cron" text DEFAULT '0 3 * * *' NOT NULL,
  "stale_after_days" integer DEFAULT 30 NOT NULL,
  "batch_size" integer DEFAULT 25 NOT NULL,
  "weekly_report_enabled" boolean DEFAULT true NOT NULL,
  "weekly_report_cron" text DEFAULT '0 6 * * 1' NOT NULL,
  "report_recipients" text,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "updated_by" text DEFAULT 'system' NOT NULL
);
--> statement-breakpoint
INSERT INTO "app_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "llm_usage" (
  "id" serial PRIMARY KEY,
  "model" text NOT NULL,
  "usage_day" text NOT NULL,
  "request_count" integer DEFAULT 0 NOT NULL,
  "prompt_tokens" integer DEFAULT 0 NOT NULL,
  "completion_tokens" integer DEFAULT 0 NOT NULL,
  "failure_count" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "llm_usage_model_day_key" ON "llm_usage" ("model", "usage_day");
