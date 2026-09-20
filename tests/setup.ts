/**
 * Vitest setup: the code under test reads configuration from `process.env`, so
 * we provide deterministic defaults. Real secrets are never required by unit
 * tests — anything that talks to Neon/Groq/CompanyEnrich is either pure or
 * dependency-injected.
 */
const env = process.env as Record<string, string | undefined>;

env.NODE_ENV = env.NODE_ENV ?? 'test';
env.SYNC_STALE_DAYS = '30';
env.SYNC_BATCH_SIZE = '25';
env.SYNC_MAX_BATCHES_PER_RUN = '12';
env.CLASSIFY_CONFIDENCE_THRESHOLD = '0.7';
env.CLASSIFY_MODEL_STRATEGY = 'tiered';
env.LLM_BATCH_SIZE = '10';
env.LLM_MAX_REQUESTS_PER_MINUTE = '25';
env.LLM_MAX_REQUESTS_PER_DAY_70B = '1000';
env.LLM_MAX_REQUESTS_PER_DAY_8B = '14400';
env.LLM_DAILY_BUDGET_RESERVE = '50';
env.ENRICH_PROVIDER = 'none';
env.ENRICH_CONCURRENCY = '3';
env.GROQ_MODEL_ACCURATE = 'llama-3.3-70b-versatile';
env.GROQ_MODEL_BULK = 'llama-3.1-8b-instant';
env.APP_ACTOR = 'test';
