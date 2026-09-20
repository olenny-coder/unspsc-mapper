/**
 * Typed browser API client.
 *
 * Every call unwraps the `{ ok, data }` envelope the routes return, so components
 * work with plain domain objects and receive an `ApiError` with the server's
 * message when something fails.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: { code?: string; status?: number; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = options.code ?? 'api_error';
    this.status = options.status ?? 500;
    this.details = options.details;
  }
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { message: string; code: string; status: number; details?: Record<string, unknown> } };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    // Send the session cookie set by /api/auth/login.
    credentials: 'same-origin',
    cache: 'no-store',
  });

  const text = await response.text();
  let payload: Envelope<T> | null = null;
  try {
    payload = text ? (JSON.parse(text) as Envelope<T>) : null;
  } catch {
    payload = null;
  }

  // An expired or missing session bounces the user to the login form instead of
  // leaving every panel showing a generic error.
  if (response.status === 401 && typeof window !== 'undefined') {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
    throw new ApiError('Your session expired. Sign in again.', { code: 'unauthorized', status: 401 });
  }

  if (!response.ok) {
    if (payload && !payload.ok) {
      throw new ApiError(payload.error.message, {
        code: payload.error.code,
        status: payload.error.status ?? response.status,
        details: payload.error.details,
      });
    }
    throw new ApiError(`Request failed with HTTP ${response.status}`, { status: response.status });
  }

  if (!payload || !payload.ok) {
    throw new ApiError('Unexpected response shape from the server.', { status: response.status });
  }
  return payload.data;
}

function toQuery(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) search.set(key, value.join(','));
      continue;
    }
    if (typeof value === 'boolean') {
      if (value) search.set(key, 'true');
      continue;
    }
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

// ---------------------------------------------------------------------------
// Response types (kept intentionally loose where the UI only renders a subset)
// ---------------------------------------------------------------------------

export type SupplierRowDto = {
  id: number;
  name: string;
  domain: string | null;
  industry: string | null;
  naics: string | null;
  sic: string | null;
  description: string | null;
  country: string | null;
  totalAmount: number;
  transactionCount: number;
  currency: string;
  parentId: number | null;
  parentName: string | null;
  isParent: boolean;
  parentSource: string | null;
  parentConfidence: number | null;
  enrichedAt: string | null;
  enrichedAtAgeDays: number | null;
  lastEnrichError: string | null;
  stale: boolean;
  staleReason: string | null;
  createdAt: string;
  updatedAt: string;
  subsidiaryCount: number;
  classification: {
    id: number;
    unspscCode: string;
    effectiveCode: string;
    confidence: number;
    reasoning: string | null;
    llmModel: string | null;
    inheritedFromParent: boolean;
    reviewed: boolean;
    correctedCode: string | null;
    segment: string | null;
    family: string | null;
    className: string | null;
    commodity: string | null;
  } | null;
};

export type SummaryDto = {
  totalSuppliers: number;
  totalSpend: number;
  classified: number;
  unclassified: number;
  percentClassified: number;
  lowConfidence: number;
  percentLowConfidence: number;
  reviewed: number;
  inherited: number;
  stale: number;
  parents: number;
  subsidiaries: number;
  averageConfidence: number | null;
  confidenceThreshold: number;
  currency: string;
};

export type SegmentDto = {
  segmentCode: string;
  segment: string;
  suppliers: number;
  spend: number;
  spendShare: number;
  avgConfidence: number | null;
};

export type ParentRollupDto = {
  clusterKey: string;
  parentId: number | null;
  parentName: string;
  parentDomain: string | null;
  isVirtualRoot: boolean;
  supplierCount: number;
  subsidiaryCount: number;
  totalAmount: number;
  unspscCode: string | null;
  confidence: number | null;
  staleCount: number;
  lowConfidenceCount: number;
};

export type ReviewRowDto = {
  supplierId: number;
  name: string;
  domain: string | null;
  industry: string | null;
  totalAmount: number;
  parentName: string | null;
  confidence: number | null;
  code: string | null;
  commodity: string | null;
  reasoning: string | null;
  llmModel: string | null;
  inheritedFromParent: boolean;
  reasons: string[];
};

export type MetricsDto = {
  threshold: number;
  summary: SummaryDto;
  segments: SegmentDto[];
  topParents: ParentRollupDto[];
  rollup: ParentRollupDto[];
  reviewQueueSize: number;
  reviewPreview: ReviewRowDto[];
  recentSuppliers: Array<{
    id: number;
    name: string;
    code: string | null;
    confidence: number | null;
    stale: boolean;
    updatedAt: string;
  }>;
  usage: {
    day: string;
    reserve: number;
    models: Array<{ model: string; requestCount: number; dailyLimit: number; remaining: number }>;
  } | null;
  enrichmentCreditsUsedThisMonth: number | null;
  lastSync: { at: string; summary: Record<string, unknown> } | null;
  settings: {
    confidenceThreshold: number;
    modelStrategy: string;
    accurateModel: string;
    bulkModel: string;
    parentDetectionEnabled: boolean;
    syncEnabled: boolean;
    staleAfterDays: number;
    batchSize: number;
    weeklyReportEnabled: boolean;
    syncCron: string;
    weeklyReportCron: string;
  };
  secrets: {
    groqConfigured: boolean;
    enrichConfigured: boolean;
    workerSecretConfigured: boolean;
    groqMasked: string | null;
    enrichMasked: string | null;
  };
};

export type UploadResultDto = {
  file: { name: string; bytes: number; delimiter: string };
  columns: string[];
  upsert: {
    rowsInFile: number;
    created: number;
    updated: number;
    unchanged: number;
    duplicateRowsInFile: number;
    supplierIds: number[];
  };
  enrichment: {
    processed: number;
    enriched: number;
    cached: number;
    failed: number;
    creditsUsed: number;
    llmParentCalls: number;
  } | null;
  parentLinks: { linked: number; parentsCreated: number; skipped: number } | null;
  classification: {
    classified: number;
    inherited: number;
    failed: number;
    lowConfidence: number;
    llmRequests: number;
  } | null;
  rowErrors: Array<{ row: number; message: string }>;
  warnings: string[];
};

export type HierarchyClusterDto = {
  key: string;
  rootId: number | null;
  rootName: string;
  rootDomain: string | null;
  isVirtualRoot: boolean;
  subsidiaryCount: number;
  totalAmount: number;
  members: Array<{
    id: number;
    name: string;
    domain: string | null;
    industry: string | null;
    isRoot: boolean;
    depth: number;
    totalAmount: number;
    parentSource: string | null;
    stale: boolean;
  }>;
};

export type ReportListDto = {
  reports: Array<{
    id: number;
    name: string;
    format: string;
    filters: Record<string, unknown> | null;
    rowCount: number;
    sizeBytes: number;
    generatedBy: string;
    createdAt: string;
    hasBlob: boolean;
  }>;
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  totalStoredBytes: number;
};

export type AuditEntryDto = {
  id: number;
  entity: string;
  entityId: number | null;
  action: string;
  details: Record<string, unknown> | null;
  actor: string;
  createdAt: string;
};

export type AuditPageDto = {
  entries: AuditEntryDto[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
};

export type SettingsDto = {
  settings: {
    id: number;
    confidenceThreshold: string;
    modelStrategy: string;
    accurateModel: string;
    bulkModel: string;
    parentDetectionEnabled: boolean;
    enrichmentEnabled: boolean;
    syncEnabled: boolean;
    syncCron: string;
    staleAfterDays: number;
    batchSize: number;
    weeklyReportEnabled: boolean;
    weeklyReportCron: string;
    reportRecipients: string | null;
    updatedAt: string;
    updatedBy: string;
    effective: {
      confidenceThreshold: number;
      accurateModel: string;
      bulkModel: string;
      modelStrategy: string;
      staleAfterDays: number;
      batchSize: number;
      syncCron: string;
      weeklyReportCron: string;
      parentDetectionEnabled: boolean;
      enrichmentEnabled: boolean;
      enrichProvider: string;
      syncEnabled: boolean;
      weeklyReportEnabled: boolean;
    };
    secrets: {
      groqConfigured: boolean;
      groqMasked: string | null;
      enrichConfigured: boolean;
      enrichMasked: string | null;
      workerSecretConfigured: boolean;
    };
    envManaged: string[];
  };
  usage: {
    day: string;
    reserve: number;
    models: Array<{ model: string; requestCount: number; dailyLimit: number; remaining: number }>;
  };
  usageHistory: Array<{
    day: string;
    model: string;
    requests: number;
    promptTokens: number;
    completionTokens: number;
    failures: number;
  }>;
  modelChoices: Array<{ id: string; label: string }>;
  taxonomyCodes: number;
  limits: {
    llmRequestsPerDayAccurate: number;
    llmRequestsPerDayBulk: number;
    llmRequestsPerMinute: number;
    llmBatchSize: number;
    enrichmentCreditsPerMonth: number;
  };
};

export type HealthDto = {
  ok: boolean;
  service: string;
  version: string;
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
  checks: Array<{ name: string; ok: boolean; detail?: string; latencyMs?: number }>;
  freeTierBudget: {
    day: string;
    reserve: number;
    models: Array<{ model: string; used: number; limit: number; remaining: number }>;
    enrichmentCreditsUsedThisMonth: number | null;
    enrichmentMonthlyLimit: number;
  } | null;
};

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  metrics: (filters?: Record<string, unknown>) => request<MetricsDto>(`/api/metrics${toQuery(filters)}`),

  suppliers: (params?: Record<string, unknown>) =>
    request<{
      rows: SupplierRowDto[];
      total: number;
      page: number;
      pageSize: number;
      pages: number;
      stats: SummaryDto;
      rollup: ParentRollupDto[];
    }>(`/api/suppliers${toQuery(params)}`),

  supplierMeta: () =>
    request<{
      segments: Array<{ segmentCode: string; segment: string; codes: number }>;
      parents: Array<{ id: number | null; name: string; subsidiaries: number; totalAmount: number }>;
      currency: string;
    }>('/api/suppliers?meta=true'),

  supplier: (id: number) =>
    request<{
      supplier: SupplierRowDto;
      parent: { id: number; name: string; domain: string | null } | null;
      subsidiaries: Array<{ id: number; name: string; domain: string | null; totalAmount: number }>;
      descendantCount: number;
      history: Array<{
        id: number;
        code: string;
        confidence: number;
        reasoning: string | null;
        llmModel: string | null;
        inherited: boolean;
        reviewed: boolean;
        superseded: boolean;
        createdAt: string;
      }>;
      corrections: Array<{
        id: number;
        originalCode: string | null;
        correctedCode: string;
        correctedBy: string;
        reason: string | null;
        appliedToSubsidiaries: boolean;
        createdAt: string;
      }>;
      audits: AuditEntryDto[];
    }>(`/api/suppliers/${id}`),

  upload: async (file: File, options: { enrich?: boolean; classify?: boolean; actor?: string } = {}) => {
    const form = new FormData();
    form.append('file', file);
    if (options.enrich !== undefined) form.append('enrich', String(options.enrich));
    if (options.classify !== undefined) form.append('classify', String(options.classify));
    if (options.actor) form.append('actor', options.actor);
    return request<UploadResultDto>(`/api/upload${toQuery({ actor: options.actor })}`, {
      method: 'POST',
      body: form,
    });
  },

  uploadTemplate: () => request<{ template: string; acceptedColumns: Record<string, string[]> }>('/api/upload'),

  enrich: (body: Record<string, unknown>) =>
    request<{
      processed: number;
      enriched: number;
      cached: number;
      failed: number;
      creditsUsed: number;
      llmParentCalls: number;
      parentLinks: { linked: number; parentsCreated: number; skipped: number };
      items: Array<{ supplierId: number; name: string; status: string; error?: string }>;
    }>('/api/enrich', { method: 'POST', body: JSON.stringify(body) }),

  classify: (body: Record<string, unknown>) =>
    request<{
      processed: number;
      classified: number;
      inherited: number;
      failed: number;
      lowConfidence: number;
      llmRequests: number;
      errors: string[];
      items: Array<{ supplierId: number; name: string; code: string | null; confidence: number; status: string }>;
      durationMs: number;
    }>('/api/classify', { method: 'POST', body: JSON.stringify(body) }),

  classifyPlan: (supplierIds?: number[]) =>
    request<{
      clusters: number;
      parentItems: Array<{ representativeName: string; rootName: string; subsidiaries: number; model: string }>;
      standalone: Array<{ id: number; name: string; model: string }>;
      totalSuppliers: number;
      estimatedRequests: number;
    }>(`/api/classify${toQuery({ plan: 'true', supplierIds })}`),

  searchCodes: (query: string, limit = 25) =>
    request<{ results: Array<{ code: string; commodity: string; segment: string | null; className: string | null }> }>(
      `/api/classify${toQuery({ q: query, limit })}`,
    ),

  segments: () => request<{ segments: SegmentDto[] }>('/api/classifications?view=segments'),

  reviewQueue: (threshold?: number) =>
    request<{ threshold: number; count: number; rows: ReviewRowDto[] }>(
      `/api/classifications${toQuery({ view: 'queue', threshold, limit: 500 })}`,
    ),

  correctClassification: (
    supplierId: number,
    body: { unspscCode: string; correctedBy?: string; reason?: string; applyToSubsidiaries?: boolean },
  ) =>
    request<{
      supplierId: number;
      originalCode: string | null;
      correctedCode: string;
      appliedToSubsidiaries: boolean;
      affectedSupplierIds: number[];
      codeKnown: boolean;
      warnings: string[];
    }>(`/api/classifications/${supplierId}`, { method: 'PATCH', body: JSON.stringify(body) }),

  clearCorrection: (supplierId: number) =>
    request<{ supplierId: number }>(`/api/classifications/${supplierId}`, { method: 'DELETE' }),

  hierarchy: (all = false) =>
    request<{
      clusters: HierarchyClusterDto[];
      totals: { clusters: number; parents: number; suppliers: number; orphans: number };
      hadCycle: boolean;
      orphans: Array<{ id: number; name: string; parentName: string | null }>;
    }>(`/api/hierarchy${toQuery({ flat: all ? 'true' : undefined })}`),

  linkParent: (body: { supplierId: number; parentId?: number; parentName?: string; parentDomain?: string }) =>
    request<{ supplierId: number; parentId: number | null; parentName: string | null }>('/api/hierarchy', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  unlinkParent: (supplierId: number, actor?: string) =>
    request<{ supplierId: number }>(`/api/hierarchy${toQuery({ supplierId, actor })}`, { method: 'DELETE' }),

  sync: (body: { mode?: string; limit?: number; actor?: string }, secret: string) =>
    request<Record<string, unknown>>('/api/sync', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${secret}` },
    }),

  reports: (params?: Record<string, unknown>) => request<ReportListDto>(`/api/reports${toQuery(params)}`),

  reportBudget: () =>
    request<{
      storedBytes: number;
      reportCount: number;
      largestReportBytes: number;
      maxStoredReportBytes: number;
      shareOfNeonFreeTier: number;
    }>('/api/reports?view=budget'),

  generateReport: (body: {
    name?: string;
    format: 'csv' | 'pdf';
    filters?: Record<string, unknown>;
    store?: boolean;
    generatedBy?: string;
    secret?: string;
  }) =>
    request<{
      name: string;
      format: string;
      filename: string;
      rows: number;
      bytes: number;
      storedId: number | null;
      summary: SummaryDto;
      filterSummary: string[];
    }>('/api/reports', {
      method: 'POST',
      body: JSON.stringify({ ...body, secret: undefined }),
      headers: body.secret ? { Authorization: `Bearer ${body.secret}` } : undefined,
    }),

  deleteReport: (id: number, secret: string) =>
    request<{ id: number; deleted: boolean }>(`/api/reports${toQuery({ id })}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${secret}` },
    }),

  previewExport: (filters: Record<string, unknown>) =>
    request<{
      summary: SummaryDto;
      segments: SegmentDto[];
      topParents: ParentRollupDto[];
      lowConfidenceCount: number;
      rowCount: number;
      filterSummary: string[];
    }>('/api/export', { method: 'POST', body: JSON.stringify({ filters, preview: true }) }),

  audit: (params?: Record<string, unknown>) => request<AuditPageDto>(`/api/audit${toQuery(params)}`),

  auditSummary: () =>
    request<{
      byAction: Array<{ action: string; count: number }>;
      byEntity: Array<{ entity: string; count: number }>;
      recent: AuditEntryDto[];
    }>('/api/audit?view=summary'),

  settings: () => request<SettingsDto>('/api/settings'),

  updateSettings: (body: Record<string, unknown>) =>
    request<{ settings: SettingsDto['settings']; changes: Array<{ key: string; from: unknown; to: unknown }>; notes: string[] }>(
      '/api/settings',
      { method: 'PATCH', body: JSON.stringify(body) },
    ),

  health: () => request<HealthDto>('/api/health'),
};

/** Build a download URL for the export endpoint (used by <a download>). */
export function exportUrl(format: 'csv' | 'pdf' | 'rollup' | 'hierarchy', filters: Record<string, unknown>, extra?: { name?: string; store?: boolean }): string {
  const params: Record<string, unknown> = { ...filters, format };
  if (extra?.name) params.name = extra.name;
  if (extra?.store) params.store = true;
  return `/api/export${toQuery(params)}`;
}
