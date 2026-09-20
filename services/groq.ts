/**
 * Groq chat-completions client.
 *
 * Design constraints that come straight from the free tier:
 *  - 1,000 requests/day on `llama-3.3-70b-versatile`
 *  - 14,400 requests/day on `llama-3.1-8b-instant`
 *
 * Therefore: batch (up to 10 suppliers per call), JSON mode everywhere, honour
 * `Retry-After`, back off exponentially with jitter, and keep a per-minute
 * token bucket so we never trip Groq's own limiter.
 */
import { getEnv, requireGroqApiKey } from '@/lib/env';
import { LlmResponseError, ProviderError, RateLimitError } from '@/lib/errors';
import { RateLimiter } from '@/lib/rate-limit';
import { fetchWithTimeout, isRetryableStatus, parseRetryAfterMs, retry, type RetryOptions } from '@/lib/retry';

export const GROQ_MODELS = {
  accurate: 'llama-3.3-70b-versatile',
  bulk: 'llama-3.1-8b-instant',
} as const;

/** Curated list for the settings dropdown. */
export const GROQ_MODEL_CHOICES = [
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile (accurate, 1k req/day)' },
  { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant (bulk, 14.4k req/day)' },
  { id: 'llama-3.3-70b-specdec', label: 'Llama 3.3 70B SpecDec (fast draft)' },
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (optional)' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (optional)' },
] as const;

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ChatCompletionOptions = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Groq supports `json_object` and `json_schema`. */
  responseFormat?: { type: 'json_object' } | { type: 'text' };
  timeoutMs?: number;
  signal?: AbortSignal;
  retry?: RetryOptions;
  /** Max ms to wait for a local rate-limit slot before failing. */
  maxRateWaitMs?: number;
  /** Skip the shared limiter (used by health checks). */
  skipRateLimit?: boolean;
};

export type ChatCompletionResult = {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: string | null;
  requestId: string | null;
};

type GroqErrorBody = { error?: { message?: string; type?: string; code?: string } };

/** Set to false by tests/scripts that run without a database. */
let usageTrackingEnabled = true;

/** Disable durable usage accounting (used by unit tests). */
export function setLlmUsageTracking(enabled: boolean): void {
  usageTrackingEnabled = enabled;
}

/**
 * Persist usage into `llm_usage` (best effort). Imported dynamically so the pure
 * prompt/parsing helpers in this module stay importable without a database.
 */
async function trackUsage(result: ChatCompletionResult, failures = 0): Promise<void> {
  if (!usageTrackingEnabled) return;
  try {
    const { recordLlmUsage } = await import('@/services/llm-usage');
    await recordLlmUsage({
      model: result.model,
      requests: 1,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      failures,
    });
  } catch (error) {
    console.error('[groq] usage tracking failed', error);
  }
}

/** Shared per-minute limiter for all Groq traffic in this process. */
let sharedLimiter: RateLimiter | null = null;

export function getGroqRateLimiter(): RateLimiter {
  if (!sharedLimiter) {
    sharedLimiter = new RateLimiter({
      perMinute: getEnv().LLM_MAX_REQUESTS_PER_MINUTE,
      label: 'groq',
    });
  }
  return sharedLimiter;
}

/** Test hook. */
export function __setGroqRateLimiter(limiter: RateLimiter | null): void {
  sharedLimiter = limiter;
}

function providerErrorFromResponse(status: number, requestId: string | null, body: unknown): ProviderError {
  const message =
    (body as GroqErrorBody)?.error?.message ??
    (typeof body === 'string' && body.trim() ? body.slice(0, 300) : `HTTP ${status}`);
  return new ProviderError('groq', `Groq request failed (${status}): ${message}`, {
    status: status === 429 ? 429 : 503,
    retryable: isRetryableStatus(status),
    details: { status, requestId, type: (body as GroqErrorBody)?.error?.type },
  });
}

/**
 * Issue one chat completion. Retries transient failures with exponential
 * backoff and honours `Retry-After`.
 */
export async function chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const env = getEnv();
  const apiKey = requireGroqApiKey();
  const url = `${env.GROQ_BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const limiter = getGroqRateLimiter();

  try {
    const result = await retry(
    async (attempt) => {
      if (!options.skipRateLimit) {
        await limiter.acquire(options.maxRateWaitMs ?? 60_000);
      }

      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'unspsc-spend-categorizer/1.0',
        },
        body: JSON.stringify({
          model: options.model,
          temperature: options.temperature ?? 0.1,
          max_tokens: options.maxTokens ?? 2048,
          response_format: options.responseFormat ?? { type: 'json_object' },
          messages: options.messages,
        }),
        timeoutMs: options.timeoutMs ?? 60_000,
        signal: options.signal,
      });

      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        let body: unknown = null;
        try {
          const text = await response.text();
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        } catch {
          body = null;
        }

        if (response.status === 429) {
          throw new RateLimitError(
            `Groq rate limit hit on ${options.model}: ${(body as GroqErrorBody)?.error?.message ?? 'too many requests'}`,
            retryAfterMs ?? 5000,
            { model: options.model, status: 429 },
          );
        }

        const error = providerErrorFromResponse(response.status, response.headers.get('x-request-id'), body);
        if (!error.retryable) throw error;
        throw new ProviderError('groq', error.message, {
          status: 503,
          retryable: true,
          details: { ...error.details, attempt },
        });
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        model?: string;
        id?: string;
      };

      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new LlmResponseError('Groq returned an empty completion', {
          model: options.model,
          finishReason: json.choices?.[0]?.finish_reason ?? null,
        });
      }

      return {
        content,
        model: json.model ?? options.model,
        usage: {
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
          totalTokens: json.usage?.total_tokens ?? 0,
        },
        finishReason: json.choices?.[0]?.finish_reason ?? null,
        requestId: json.id ?? response.headers.get('x-request-id'),
      };
    },
    {
      attempts: 4,
      baseDelayMs: 800,
      maxDelayMs: 20_000,
      jitter: 0.25,
      label: `groq:${options.model}`,
      // Never retry a malformed-payload error: it is not transient.
      shouldRetry: (error) => !(error instanceof LlmResponseError && !(error.details?.retryable === true)),
      ...options.retry,
    },
    );

    await trackUsage(result, 0);
    return result;
  } catch (error) {
    // Count the failed attempt against the daily budget too: Groq bills the
    // request even when the response is unusable, and the free-tier guard must
    // stay conservative.
    await trackUsage(
      {
        content: '',
        model: options.model,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: null,
        requestId: null,
      },
      1,
    );
    throw error;
  }
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * Extract a JSON value from an LLM response that may be wrapped in markdown
 * fences or surrounded by prose. Returns the raw JSON text.
 */
export function extractJsonText(raw: string): string {
  let text = String(raw ?? '').trim();
  if (!text) throw new LlmResponseError('Empty LLM response');

  // Strip ```json ... ``` fences.
  const fenced = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  // Remove a leading BOM or zero-width chars.
  text = text.replace(/^\uFEFF/, '').trim();

  if (text.startsWith('{') || text.startsWith('[')) return text;

  // Find the outermost object/array in a prose answer.
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const starts = [firstBrace, firstBracket].filter((i) => i >= 0);
  if (!starts.length) {
    throw new LlmResponseError('LLM response contains no JSON object or array', { preview: text.slice(0, 200) });
  }
  const start = Math.min(...starts);
  const openChar = text[start];
  const closeChar = openChar === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new LlmResponseError('Unbalanced JSON in LLM response', { preview: text.slice(0, 200) });
}

/** Parse JSON from an LLM response, tolerating fences and trailing commas. */
export function parseJsonResponse<T = unknown>(raw: string): T {
  const text = extractJsonText(raw);
  try {
    return JSON.parse(text) as T;
  } catch {
    // Single repair pass: drop trailing commas.
    const repaired = text.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(repaired) as T;
    } catch (error) {
      throw new LlmResponseError('Could not parse JSON returned by the model', {
        preview: text.slice(0, 300),
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Ask whether Groq is reachable with the configured key. Used by `/api/health`
 * and the settings page; never throws.
 */
export async function checkGroqHealth(): Promise<{
  ok: boolean;
  model?: string;
  error?: string;
}> {
  const env = getEnv();
  if (!env.GROQ_API_KEY) return { ok: false, error: 'GROQ_API_KEY is not configured' };
  try {
    const result = await chatCompletion({
      model: env.GROQ_MODEL_BULK,
      messages: [
        { role: 'system', content: 'Reply with JSON only.' },
        { role: 'user', content: 'Return {"ok":true}' },
      ],
      maxTokens: 16,
      timeoutMs: 10_000,
      skipRateLimit: true,
      retry: { attempts: 1 },
    });
    parseJsonResponse(result.content);
    return { ok: true, model: result.model };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
