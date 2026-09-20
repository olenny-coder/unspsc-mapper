'use client';

import * as React from 'react';
import { Filter, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';

export type DashboardFilterState = {
  minConfidence: string;
  segment: string;
  parent: string;
  search: string;
  confidenceState: 'all' | 'low' | 'reviewed' | 'unreviewed' | 'unclassified';
  onlyStale: boolean;
  onlyParents: boolean;
  onlySubsidiaries: boolean;
  rollup: 'supplier' | 'parent';
  from: string;
  to: string;
};

export const EMPTY_FILTERS: DashboardFilterState = {
  minConfidence: '',
  segment: '',
  parent: '',
  search: '',
  confidenceState: 'all',
  onlyStale: false,
  onlyParents: false,
  onlySubsidiaries: false,
  rollup: 'supplier',
  from: '',
  to: '',
};

/** Convert UI state into the query parameters the API/report layer expects. */
export function toApiFilters(state: DashboardFilterState): Record<string, unknown> {
  return {
    minConfidence: state.minConfidence === '' ? undefined : Number(state.minConfidence),
    segment: state.segment || undefined,
    parent: state.parent || undefined,
    search: state.search || undefined,
    confidenceState: state.confidenceState === 'all' ? undefined : state.confidenceState,
    onlyStale: state.onlyStale || undefined,
    onlyParents: state.onlyParents || undefined,
    onlySubsidiaries: state.onlySubsidiaries || undefined,
    rollup: state.rollup,
    from: state.from || undefined,
    to: state.to || undefined,
  };
}

export function countActiveFilters(state: DashboardFilterState): number {
  return Object.values(toApiFilters(state)).filter((value) => value !== undefined && value !== false && value !== 'supplier')
    .length;
}

export function FilterBar({
  state,
  onChange,
  segments,
  parents,
  right,
}: {
  state: DashboardFilterState;
  onChange: (next: DashboardFilterState) => void;
  segments: Array<{ segmentCode: string; segment: string; codes: number }>;
  parents: Array<{ id: number | null; name: string; subsidiaries: number }>;
  right?: React.ReactNode;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const active = countActiveFilters(state);
  const set = <K extends keyof DashboardFilterState>(key: K, value: DashboardFilterState[K]) =>
    onChange({ ...state, [key]: value });

  return (
    <div className="rounded-lg border bg-card p-3 sm:p-4">
      {/*
        Mobile: every control becomes a full-width row so nothing is squeezed
        into an unusable sliver. From `sm` up they sit side by side in a wrapping
        toolbar, which is where the fixed widths become useful.
      */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="w-full space-y-1 sm:min-w-[220px] sm:flex-1">
          <Label htmlFor="filter-search">Search</Label>
          <Input
            id="filter-search"
            placeholder="Supplier, domain, industry or parent…"
            value={state.search}
            onChange={(event) => set('search', event.target.value)}
          />
        </div>

        <div className="w-full space-y-1 sm:w-[150px]">
          <Label htmlFor="filter-confidence">Min confidence</Label>
          <Input
            id="filter-confidence"
            type="number"
            min={0}
            max={1}
            step={0.05}
            placeholder="0.70"
            value={state.minConfidence}
            onChange={(event) => set('minConfidence', event.target.value)}
          />
        </div>

        <div className="w-full space-y-1 sm:w-[190px]">
          <Label>State</Label>
          <Select
            value={state.confidenceState}
            onValueChange={(value) => set('confidenceState', value as DashboardFilterState['confidenceState'])}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All suppliers</SelectItem>
              <SelectItem value="low">Low confidence (needs review)</SelectItem>
              <SelectItem value="reviewed">Reviewed</SelectItem>
              <SelectItem value="unreviewed">Not yet reviewed</SelectItem>
              <SelectItem value="unclassified">Unclassified</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="w-full space-y-1 sm:w-[220px]">
          <Label>UNSPSC segment</Label>
          <Select value={state.segment || 'all'} onValueChange={(value) => set('segment', value === 'all' ? '' : value)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All segments</SelectItem>
              {segments.map((segment) => (
                <SelectItem key={segment.segmentCode} value={segment.segmentCode}>
                  {segment.segmentCode} — {segment.segment}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:w-auto">
          <Button variant="outline" size="sm" onClick={() => setExpanded((value) => !value)}>
            <Filter className="h-4 w-4" />
            More filters
            {active ? <Badge variant="secondary">{active}</Badge> : null}
          </Button>

          {active ? (
            <Button variant="ghost" size="sm" onClick={() => onChange(EMPTY_FILTERS)}>
              <RotateCcw className="h-4 w-4" />
              Reset
            </Button>
          ) : null}
        </div>

        {right ? <div className="w-full sm:ml-auto sm:w-auto">{right}</div> : null}
      </div>

      {expanded ? (
        <div className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label>Parent company</Label>
            <Select value={state.parent || 'all'} onValueChange={(value) => set('parent', value === 'all' ? '' : value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All parents</SelectItem>
                {parents.map((parent) => (
                  <SelectItem key={`${parent.id ?? parent.name}`} value={parent.name}>
                    {parent.name} ({parent.subsidiaries})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label>Roll-up</Label>
            <Select value={state.rollup} onValueChange={(value) => set('rollup', value as 'supplier' | 'parent')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="supplier">One row per supplier</SelectItem>
                <SelectItem value="parent">Roll up by parent company</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="filter-from">Created from</Label>
            <Input id="filter-from" type="date" value={state.from} onChange={(event) => set('from', event.target.value)} />
          </div>

          <div className="space-y-1">
            <Label htmlFor="filter-to">Created to</Label>
            <Input id="filter-to" type="date" value={state.to} onChange={(event) => set('to', event.target.value)} />
          </div>

          <div className="flex flex-col gap-3 sm:col-span-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4 lg:col-span-4">
            <Toggle
              id="only-stale"
              label="Stale / unenriched only"
              checked={state.onlyStale}
              onChange={(value) => set('onlyStale', value)}
            />
            <Toggle
              id="only-parents"
              label="Parents only"
              checked={state.onlyParents}
              onChange={(value) => set('onlyParents', value)}
            />
            <Toggle
              id="only-subs"
              label="Subsidiaries only"
              checked={state.onlySubsidiaries}
              onChange={(value) => set('onlySubsidiaries', value)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    /* py-1 gives the checkbox a comfortable thumb target without a visible box. */
    <label htmlFor={id} className="flex items-center gap-2 py-1 text-sm">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      {label}
    </label>
  );
}
