import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  OctopusApi,
  toUtcIso,
  type OctopusAccount,
  type MeterPoint,
  type Product,
  type ConsumptionResult,
  type Agreement,
  groupProductFamilies,
  productFamilyPrefix,
} from './api';
import {
  CostEngine,
  type CostCalculation,
  type Rate,
  getGspFromMpan,
  calculateOfgemCapCost,
} from './CostEngine';
import {
  ComposedChart,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DashboardProps {
  api: OctopusApi;
}

type Timeframe = '7days' | '30days' | '1year';
type AppView = 'tracker' | 'usage' | 'compare';

interface MeterInfo {
  id: string;
  label: string; // e.g. "Electricity Import", "Gas"
  fuelType: 'electricity' | 'gas';
  isExport: boolean;
  /** All serial numbers listed on this meter point, preference-ordered */
  serials: string[];
  /** The confirmed active serial (found by probing the API) */
  activeSerial: string | null;
  point: MeterPoint;
}

interface MeterData {
  meter: MeterInfo;
  current: ConsumptionResult[];
  prior: ConsumptionResult[];
  /** Latest date available in the API for this meter */
  latestDate: Date | null;
  currentCost: CostCalculation | null;
  priorCost: CostCalculation | null;
  currentUnitRates: Rate[];
  currentStandingRates: Rate[];
  priorUnitRates: Rate[];
  priorStandingRates: Rate[];
  loading: boolean;
  error: string | null;
}

interface BaselineResult {
  current: CostCalculation;
  ofgem: CostCalculation;
  tariffCode: string;
  productCode: string;
  /** Full product name e.g. "Octopus Tracker April 2025 v2" */
  productFullName: string | null;
  regionLetter: string;
}

/** Result for a single alternative tariff in the comparison table */
interface AltResult {
  result: CostCalculation;
  /** Current tariff cost computed over the same covered window (only set for partial tariffs) */
  currentForSamePeriod: CostCalculation | null;
}

interface TrackerDayRate {
  date: string;        // local date key YYYY-MM-DD
  label: string;       // e.g. "3 Apr"
  rateIncVat: number;  // p/kWh
  valid_from: string;  // raw ISO from API
}

interface SvtRateEntry {
  valid_from: string;       // ISO UTC
  valid_to: string | null;  // ISO UTC or null (= current)
  value_inc_vat: number;    // p/kWh
}

interface TrackerFuelData {
  /** Daily rates for the selected period, sorted oldest-first */
  rates: TrackerDayRate[];
  /** Full SVT rate history for the period, sorted newest-first */
  svtRates: SvtRateEntry[];
  /** Cost on Tracker tariff */
  trackerCost: CostCalculation | null;
  /** Cost on SVT */
  svtCost: CostCalculation | null;
}

interface TrackerData {
  loading: boolean;
  error: string | null;
  electricity: TrackerFuelData;
  /** null if the user has no gas meter on this Tracker product */
  gas: TrackerFuelData | null;
  svtProductCode: string | null;
  /** The current (newest) Tracker product the user could switch to */
  currentTrackerProduct: { productCode: string; tariffCode: string; fullName: string } | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Order serials for a meter point: prefer meters with a named rate
 * (i.e. the active settlement meter) over those with an empty rate string.
 */
function orderSerials(point: MeterPoint): string[] {
  const meters = point.meters ?? [];
  // Meters with a non-empty rate value on any register are the active ones
  const active = meters.filter(m =>
    m.registers?.some(r => r.rate && r.rate !== '' && r.is_settlement_register)
  );
  const inactive = meters.filter(
    m => !m.registers?.some(r => r.rate && r.rate !== '' && r.is_settlement_register)
  );
  return [...active, ...inactive].map(m => m.serial_number).filter(Boolean);
}

function buildMeterList(account: OctopusAccount): MeterInfo[] {
  const property = account.properties[0];
  if (!property) return [];

  const elec: MeterInfo[] = (property.electricity_meter_points ?? []).map(m => ({
    id: m.mpan!,
    label: m.is_export ? 'Electricity Export' : 'Electricity Import',
    fuelType: 'electricity' as const,
    isExport: m.is_export ?? false,
    serials: orderSerials(m),
    activeSerial: null,
    point: m,
  }));

  const gas: MeterInfo[] = (property.gas_meter_points ?? []).map(m => ({
    id: m.mprn!,
    label: 'Gas',
    fuelType: 'gas' as const,
    isExport: false,
    serials: orderSerials(m),
    activeSerial: null,
    point: m,
  }));

  return [...elec, ...gas].filter(m => m.id && m.serials.length > 0);
}

function getActiveAgreement(agreements: Agreement[] | undefined): Agreement | null {
  if (!agreements?.length) return null;
  const now = new Date();
  const sorted = [...agreements].sort(
    (a, b) => new Date(b.valid_from).getTime() - new Date(a.valid_from).getTime()
  );
  // Find the most-recent agreement that has already started AND has not yet ended.
  // Excluding future agreements (valid_from > now) prevents a pre-provisioned
  // upcoming agreement from being mistakenly treated as the current one.
  return (
    sorted.find(ag => new Date(ag.valid_from) <= now && (!ag.valid_to || new Date(ag.valid_to) > now)) ??
    sorted[0]
  );
}

/**
 * Returns all agreements that overlap a date range, sorted oldest-first,
 * with each agreement's effective period clamped to the given bounds.
 */
function getOverlappingAgreements(
  agreements: Agreement[] | undefined,
  periodFrom: string,
  periodTo: string,
): { agreement: Agreement; clampedFrom: string; clampedTo: string }[] {
  if (!agreements?.length) return [];
  const fromMs = new Date(periodFrom).getTime();
  const toMs = new Date(periodTo).getTime();

  return agreements
    .filter(ag => {
      const agFrom = new Date(ag.valid_from).getTime();
      const agTo = ag.valid_to ? new Date(ag.valid_to).getTime() : Infinity;
      return agFrom < toMs && agTo > fromMs;
    })
    .sort((a, b) => new Date(a.valid_from).getTime() - new Date(b.valid_from).getTime())
    .map(ag => {
      const agFrom = new Date(ag.valid_from).getTime();
      const agTo = ag.valid_to ? new Date(ag.valid_to).getTime() : Infinity;
      return {
        agreement: ag,
        clampedFrom: new Date(Math.max(agFrom, fromMs)).toISOString(),
        clampedTo: agTo === Infinity ? periodTo : new Date(Math.min(agTo, toMs)).toISOString(),
      };
    });
}

/**
 * Fetch and combine unit rates or standing charges from multiple overlapping
 * agreements for a period, clipping rate boundaries at agreement transitions
 * so there are no overlaps.  Follows the same clip-and-merge pattern used by
 * fetchFamilyChainedRates in api.ts.
 */
async function fetchCombinedAgreementRates(
  api: OctopusApi,
  agreements: Agreement[] | undefined,
  fuelType: 'electricity' | 'gas',
  periodFrom: string,
  periodTo: string,
  rateType: 'unit' | 'standing',
): Promise<{ value_inc_vat: number; valid_from: string; valid_to: string | null; payment_method: string | null }[]> {
  const overlapping = getOverlappingAgreements(agreements, periodFrom, periodTo);
  if (overlapping.length === 0) return [];

  const segmentRates = await Promise.all(
    overlapping.map(async ({ agreement, clampedFrom, clampedTo }) => {
      const productCode = productCodeFromTariffCode(agreement.tariff_code);
      try {
        const rates = rateType === 'unit'
          ? await api.fetchUnitRates(productCode, agreement.tariff_code, fuelType, clampedFrom, clampedTo)
          : await api.fetchStandingCharges(productCode, agreement.tariff_code, fuelType, clampedFrom, clampedTo);
        return rates.map(r => ({
          ...r,
          valid_from: r.valid_from && new Date(r.valid_from).getTime() < new Date(clampedFrom).getTime()
            ? clampedFrom : r.valid_from,
          valid_to: r.valid_to && new Date(r.valid_to).getTime() > new Date(clampedTo).getTime()
            ? clampedTo : r.valid_to,
        }));
      } catch {
        return [];
      }
    })
  );

  return segmentRates
    .flat()
    .sort((a, b) => new Date(a.valid_from).getTime() - new Date(b.valid_from).getTime());
}

function productCodeFromTariffCode(tariffCode: string): string {
  // Pattern: {E|G}-{1R|2R}-{PRODUCT_CODE}-{REGION}
  const parts = tariffCode.split('-');
  if (parts.length >= 4) return parts.slice(2, -1).join('-');
  return tariffCode;
}

/** Returns true if the product code looks like a Tracker tariff (e.g. SILVER-25-04-15) */
function isTrackerProductCode(productCode: string): boolean {
  // Tracker products all have display_name "Octopus Tracker" and use the SILVER-* prefix
  // We detect by the date-versioned SILVER- pattern; is_tracker flag is on the Product object
  // but we also need to handle cases where the product isn't in the public list
  return /^SILVER-\d{2}-\d{2}-\d{2}$/.test(productCode);
}


function penceToGBP(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/** Format a local date as YYYY-MM-DD using local timezone (not UTC) */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function aggregateByDay(consumption: ConsumptionResult[], maxDays?: number) {
  const todayKey = localDateKey(new Date());
  const daily: Record<string, number> = {};
  for (const item of consumption) {
    const key = localDateKey(new Date(item.interval_start));
    // Never include future dates
    if (key > todayKey) continue;
    daily[key] = (daily[key] ?? 0) + item.consumption;
  }
  const sorted = Object.keys(daily).sort();
  // Trim to the last N days if requested
  const trimmed = maxDays ? sorted.slice(-maxDays) : sorted;
  return trimmed.map(k => {
    const d = new Date(k + 'T12:00:00');
    return {
      date: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
      dow: d.toLocaleDateString('en-GB', { weekday: 'short' }),
      dateKey: k,
      kWh: Number(daily[k].toFixed(3)),
    };
  });
}

function aggregateByMonth(consumption: ConsumptionResult[]) {
  const monthly: Record<string, number> = {};
  for (const item of consumption) {
    const d = new Date(item.interval_start);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthly[key] = (monthly[key] ?? 0) + item.consumption;
  }
  return Object.keys(monthly).sort().map(k => {
    const [y, m] = k.split('-');
    return {
      date: new Date(Number(y), Number(m) - 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
      dow: '',
      dateKey: k,
      kWh: Number(monthly[k].toFixed(3)),
    };
  });
}

/** Returns a recharts custom tick renderer that shows date + day-of-week on two lines */
function makeDowTick(data: { date: string; dow: string }[]) {
  return function DowTick({ x, y, payload, index }: { x: number; y: number; payload: { value: string }; index: number }) {
    const dow = data[index]?.dow ?? '';
    return (
      <g transform={`translate(${x},${y})`}>
        <text x={0} y={0} dy={12} textAnchor="middle" fill="var(--text-secondary)" fontSize={11}>{payload.value}</text>
        <text x={0} y={0} dy={24} textAnchor="middle" fill="var(--text-secondary)" fontSize={10} opacity={0.65}>{dow}</text>
      </g>
    );
  };
}

/** Merge current + prior period into a single chart dataset.
 *  Aligns by index offset (day 1 of current vs day 1 of prior) so that
 *  the x-axis label and dow come from the current period only.
 *  The chart always has exactly current.length entries. */
function mergePeriodsForChart(
  current: ReturnType<typeof aggregateByDay>,
  prior: ReturnType<typeof aggregateByDay>,
  currentLabel: string,
  priorLabel: string
) {
  return current.map((c, i) => ({
    date: c.date,
    dow: c.dow,
    dateKey: c.dateKey,
    [currentLabel]: c.kWh,
    [priorLabel]: prior[i]?.kWh ?? null,
  }));
}

/** Compute cost (pence) per aggregated period (day or month) from consumption + rates.
 *  Returns a map from dateKey → total cost in pence (unit + standing). */
function computePeriodCosts(
  consumption: ConsumptionResult[],
  unitRates: Rate[],
  standingRates: Rate[],
  monthly: boolean,
): Record<string, number> {
  if (!unitRates.length) return {};

  const parsedUR = unitRates.map(r => ({
    start: r.valid_from ? new Date(r.valid_from).getTime() : 0,
    end: r.valid_to ? new Date(r.valid_to).getTime() : Infinity,
    value: r.value_inc_vat,
  }));
  const fallbackUR = unitRates[0]?.value_inc_vat ?? 0;

  const parsedSC = standingRates.map(r => ({
    start: r.valid_from ? new Date(r.valid_from).getTime() : 0,
    end: r.valid_to ? new Date(r.valid_to).getTime() : Infinity,
    value: r.value_inc_vat,
  }));
  const fallbackSC = standingRates[0]?.value_inc_vat ?? 0;

  const buckets: Record<string, { unitPence: number; days: Set<string> }> = {};

  for (const item of consumption) {
    const d = new Date(item.interval_start);
    const key = monthly
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      : localDateKey(d);
    if (!buckets[key]) buckets[key] = { unitPence: 0, days: new Set() };
    buckets[key].days.add(localDateKey(d));

    const ts = d.getTime();
    let rate = fallbackUR;
    for (const r of parsedUR) {
      if (ts >= r.start && ts < r.end) { rate = r.value; break; }
    }
    buckets[key].unitPence += item.consumption * rate;
  }

  const result: Record<string, number> = {};
  for (const [key, bucket] of Object.entries(buckets)) {
    let sc = 0;
    if (parsedSC.length) {
      for (const dayKey of bucket.days) {
        const dayTs = new Date(dayKey + 'T12:00:00').getTime();
        let scRate = fallbackSC;
        for (const r of parsedSC) {
          if (dayTs >= r.start && dayTs < r.end) { scRate = r.value; break; }
        }
        sc += scRate;
      }
    }
    result[key] = bucket.unitPence + sc;
  }
  return result;
}

function timeframeDays(tf: Timeframe): number {
  return tf === '7days' ? 7 : tf === '1year' ? 365 : 30;
}

function timeframeLabel(tf: Timeframe): string {
  return tf === '7days' ? 'Last 7 days' : tf === '1year' ? 'Last 12 months' : 'Last 30 days';
}

function priorPeriodLabel(tf: Timeframe): string {
  return tf === '7days' ? 'Prior 7 days' : tf === '1year' ? 'Prior 12 months' : 'Prior 30 days';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SummaryCard({
  label, value, sub, highlight, delta,
}: {
  label: string; value: string; sub?: string; highlight?: boolean;
  delta?: { value: string; positive: boolean | null };
}) {
  return (
    <div className="panel flex-col" style={{
      flex: '1 1 130px', gap: '0.25rem',
      border: highlight ? '1px solid var(--accent-color)' : undefined,
      background: highlight ? 'rgba(229,0,122,0.06)' : undefined,
    }}>
      <span className="text-secondary" style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </span>
      <span style={{
        fontSize: '1.4rem', fontWeight: 700, lineHeight: 1.15,
        color: delta
          ? delta.positive === null ? 'var(--text-secondary)' : delta.positive ? 'var(--success-color)' : 'var(--error-color)'
          : undefined,
      }}>{value}</span>
      {delta?.value && (
        <span style={{
          fontSize: '0.8rem', fontWeight: 600,
          color: delta.positive === null ? 'var(--text-secondary)' : delta.positive ? 'var(--success-color)' : 'var(--error-color)',
        }}>
          {delta.value}
        </span>
      )}
      {sub && <span className="text-secondary" style={{ fontSize: '0.75rem' }}>{sub}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tracker panel
// ---------------------------------------------------------------------------

/** Shared sub-component for one fuel's rate cards + chart + cost comparison */
function TrackerFuelSection({
  label,
  fuelData,
  timeframe,
  accentColor,
}: {
  label: string;
  fuelData: TrackerFuelData;
  timeframe: Timeframe;
  accentColor: string;
}) {
  const { rates, svtRates, trackerCost, svtCost } = fuelData;

  const now = new Date();
  const todayKey = localDateKey(now);
  const tomorrowKey = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const yesterdayKey = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));

  const todayRate = rates.find(r => r.date === todayKey);
  const tomorrowRate = rates.find(r => r.date === tomorrowKey);
  const yesterdayRate = rates.find(r => r.date === yesterdayKey);

  /** Find the SVT rate applicable on a given local date key (YYYY-MM-DD).
   *  svtRates is sorted oldest-first; we want the last entry whose valid_from
   *  is on or before noon local time on that date. */
  const svtRateOnDate = useCallback((dateKey: string): number | null => {
    if (svtRates.length === 0) return null;
    const noon = new Date(dateKey + 'T12:00:00').getTime();
    let match: SvtRateEntry | null = null;
    for (const entry of svtRates) {
      if (new Date(entry.valid_from).getTime() <= noon) {
        match = entry;
      } else {
        break;
      }
    }
    return match?.value_inc_vat ?? null;
  }, [svtRates]);

  /** Current SVT rate = most recent entry with valid_from <= now */
  const currentSvtRate = useMemo((): number | null => {
    if (svtRates.length === 0) return null;
    const nowMs = now.getTime();
    let match: SvtRateEntry | null = null;
    for (const entry of svtRates) {
      if (new Date(entry.valid_from).getTime() <= nowMs) match = entry;
      else break;
    }
    return match?.value_inc_vat ?? null;
  }, [svtRates, now]);

  const chartData = useMemo(() => {
    const days = timeframeDays(timeframe);
    return rates.slice(-days).map(r => ({
      date: r.label,
      dow: new Date(r.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' }),
      rate: r.rateIncVat,
      svt: svtRateOnDate(r.date),
    }));
  }, [rates, timeframe, svtRateOnDate]);

  const savingPence = trackerCost && svtCost ? svtCost.totalCostPence - trackerCost.totalCostPence : null;
  // Unit-cost delta (excluding standing charge) — helps explain when unit rates look cheaper but total is higher
  const unitSavingPence = trackerCost && svtCost ? svtCost.unitCostPence - trackerCost.unitCostPence : null;
  const scDeltaPence = trackerCost && svtCost ? trackerCost.standingChargePence - svtCost.standingChargePence : null;

  const rateCard = (highlighted: boolean, faded: boolean): React.CSSProperties => ({
    flex: '1 1 120px', padding: '0.85rem 1rem', borderRadius: '8px',
    border: '1px solid var(--border-color)',
    background: highlighted ? accentColor : 'var(--input-bg)',
    opacity: faded ? 0.55 : 1, textAlign: 'center',
  });

  return (
    <div className="panel flex-col gap-3">
      <h3 style={{ margin: 0 }}>{label}</h3>

      {/* Rate cards */}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div style={rateCard(false, false)}>
          <div className="text-secondary" style={{ fontSize: '0.75rem', marginBottom: '0.35rem' }}>Yesterday</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{yesterdayRate ? `${yesterdayRate.rateIncVat.toFixed(2)}p` : '—'}</div>
          <div className="text-secondary" style={{ fontSize: '0.72rem' }}>per kWh</div>
        </div>

        <div style={rateCard(true, false)}>
          <div style={{ fontSize: '0.75rem', marginBottom: '0.35rem', color: 'rgba(255,255,255,0.75)' }}>Today</div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#fff' }}>{todayRate ? `${todayRate.rateIncVat.toFixed(2)}p` : '—'}</div>
          <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.6)' }}>per kWh</div>
          {todayRate && yesterdayRate && (() => {
            const diff = todayRate.rateIncVat - yesterdayRate.rateIncVat;
            const pct = (diff / yesterdayRate.rateIncVat) * 100;
            const up = diff > 0;
            return (
              <div style={{ fontSize: '0.72rem', marginTop: '0.3rem', color: up ? 'rgba(255,160,160,0.9)' : 'rgba(160,255,160,0.9)' }}>
                {up ? '▲' : '▼'} {Math.abs(diff).toFixed(2)}p ({Math.abs(pct).toFixed(0)}%) vs yesterday
              </div>
            );
          })()}
        </div>

        <div style={rateCard(false, !tomorrowRate)}>
          <div className="text-secondary" style={{ fontSize: '0.75rem', marginBottom: '0.35rem' }}>Tomorrow</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            {tomorrowRate ? `${tomorrowRate.rateIncVat.toFixed(2)}p` : 'Not yet published'}
          </div>
          {tomorrowRate && <div className="text-secondary" style={{ fontSize: '0.72rem' }}>per kWh</div>}
          {tomorrowRate && todayRate && (() => {
            const diff = tomorrowRate.rateIncVat - todayRate.rateIncVat;
            const pct = (diff / todayRate.rateIncVat) * 100;
            const up = diff > 0;
            return (
              <div className="text-secondary" style={{ fontSize: '0.72rem', marginTop: '0.3rem' }}>
                {up ? '▲' : '▼'} {Math.abs(diff).toFixed(2)}p ({Math.abs(pct).toFixed(0)}%) vs today
              </div>
            );
          })()}
        </div>

        {currentSvtRate !== null && (
          <div style={rateCard(false, false)}>
            <div className="text-secondary" style={{ fontSize: '0.75rem', marginBottom: '0.35rem' }}>Flexible Octopus</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{currentSvtRate.toFixed(2)}p</div>
            <div className="text-secondary" style={{ fontSize: '0.72rem' }}>per kWh (flat)</div>
            {todayRate && (() => {
              const diff = todayRate.rateIncVat - currentSvtRate;
              const cheaper = diff < 0;
              return (
                <div style={{ fontSize: '0.72rem', marginTop: '0.3rem', color: cheaper ? 'var(--success-color)' : 'var(--error-color)' }}>
                  Tracker is {cheaper ? `${Math.abs(diff).toFixed(2)}p cheaper` : `${diff.toFixed(2)}p more expensive`} today
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Rate trend chart */}
      {chartData.length > 1 && (
        <div style={{ width: '100%', height: 200 }}>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
              <XAxis dataKey="date" stroke="var(--text-secondary)"
                interval={timeframe === '1year' ? Math.floor(chartData.length / 12) : timeframe === '7days' ? 0 : 'preserveStartEnd'}
                height={timeframe === '7days' ? 36 : 20}
                tick={timeframe === '7days'
                  ? (makeDowTick(chartData as unknown as { date: string; dow: string }[]) as React.FC)
                  : { fontSize: 11 } as object
                } />
              <YAxis stroke="var(--text-secondary)" tick={{ fontSize: 11 }} unit="p" width={50}
                domain={([dataMin, dataMax]: readonly number[]) => [Math.max(0, (dataMin as number) - 2), (dataMax as number) + 2]} />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                contentStyle={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-color)', color: 'var(--text-primary)', borderRadius: '8px', fontSize: '0.85rem' }}
                wrapperStyle={{ opacity: 1, zIndex: 10 }}
                formatter={(v: unknown, name: unknown) => {
                  const val = (v as number).toFixed(2);
                  return name === 'svt' ? [`${val}p/kWh`, 'Flexible Octopus'] : [`${val}p/kWh`, 'Tracker rate'];
                }}
              />
              <Bar dataKey="rate" name="Tracker rate" fill={accentColor} radius={[3, 3, 0, 0]} />
              {svtRates.length > 0 && (
                <Line
                  dataKey="svt"
                  name="svt"
                  type="stepAfter"
                  dot={false}
                  activeDot={{ r: 3 }}
                  stroke="var(--text-secondary)"
                  strokeDasharray="6 3"
                  strokeWidth={1.5}
                  connectNulls={false}
                  legendType="none"
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Cost comparison */}
      {(trackerCost || svtCost) && (
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', paddingTop: '0.25rem', borderTop: '1px solid var(--border-color)' }}>
          {trackerCost && (
            <div style={{ flex: '1 1 130px' }}>
              <div className="text-secondary" style={{ fontSize: '0.72rem', marginBottom: '0.2rem' }}>Tracker cost</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{penceToGBP(trackerCost.totalCostPence)}</div>
              <div className="text-secondary" style={{ fontSize: '0.7rem' }}>{trackerCost.averagePencePerKwh.toFixed(2)}p avg · {penceToGBP(trackerCost.standingChargePence)} standing</div>
            </div>
          )}
          {svtCost && (
            <div style={{ flex: '1 1 130px' }}>
              <div className="text-secondary" style={{ fontSize: '0.72rem', marginBottom: '0.2rem' }}>Flexible Octopus cost</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{penceToGBP(svtCost.totalCostPence)}</div>
              <div className="text-secondary" style={{ fontSize: '0.7rem' }}>{svtCost.averagePencePerKwh.toFixed(2)}p avg · {penceToGBP(svtCost.standingChargePence)} standing</div>
            </div>
          )}
          {savingPence !== null && unitSavingPence !== null && scDeltaPence !== null && (
            <div style={{ flex: '1 1 130px' }}>
              <div className="text-secondary" style={{ fontSize: '0.72rem', marginBottom: '0.2rem' }}>
                {savingPence > 0 ? 'You saved' : 'You paid extra'} (total inc. standing)
              </div>
              <div style={{ fontSize: '1.25rem', fontWeight: 700, color: savingPence > 0 ? 'var(--success-color)' : 'var(--error-color)' }}>
                {penceToGBP(Math.abs(savingPence))}
              </div>
              <div className="text-secondary" style={{ fontSize: '0.7rem' }}>
                {unitSavingPence >= 0
                  ? `${penceToGBP(unitSavingPence)} cheaper on units`
                  : `${penceToGBP(Math.abs(unitSavingPence))} more on units`}
                {scDeltaPence > 0
                  ? `, but ${penceToGBP(scDeltaPence)} more on standing charge`
                  : scDeltaPence < 0
                    ? `, ${penceToGBP(Math.abs(scDeltaPence))} less on standing charge`
                    : ''}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TrackerPanel({
  data,
  timeframe,
}: {
  data: TrackerData;
  timeframe: Timeframe;
}) {
  const { loading, error, electricity, gas, currentTrackerProduct } = data;

  if (loading) {
    return (
      <div className="panel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '3rem 0', gap: '0.75rem' }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          border: '3px solid var(--border-color)',
          borderTopColor: 'var(--accent-color)',
          animation: 'spin 0.8s linear infinite',
        }} />
        <span className="text-secondary" style={{ fontSize: '0.85rem' }}>Loading Tracker rates…</span>
      </div>
    );
  }
  if (error) {
    return <div className="panel"><p style={{ color: 'var(--error-color)' }}>Failed to load Tracker data: {error}</p></div>;
  }

  return (
    <div className="flex-col gap-4">
      <TrackerFuelSection
        label="Electricity"
        fuelData={electricity}
        timeframe={timeframe}
        accentColor="var(--accent-color)"
      />

      {gas && (
        <TrackerFuelSection
          label="Gas"
          fuelData={gas}
          timeframe={timeframe}
          accentColor="#e8833a"
        />
      )}

      {currentTrackerProduct && (
        <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>Newer Tracker available</div>
            <div className="text-secondary" style={{ fontSize: '0.82rem', marginTop: '0.15rem' }}>
              {currentTrackerProduct.fullName} — compare it in the Compare tab
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meter panel — shows one meter's usage + period comparison
// ---------------------------------------------------------------------------

const MeterPanel = React.memo(function MeterPanel({
  data, timeframe,
}: {
  data: MeterData;
  timeframe: Timeframe;
}) {
  const { meter, current, prior, currentCost, priorCost, loading, error,
    currentUnitRates, currentStandingRates, priorUnitRates, priorStandingRates } = data;
  const useMonthly = timeframe === '1year';

  const maxDays = timeframe === '7days' ? 7 : timeframe === '30days' ? 30 : undefined;
  const currentAgg = useMemo(
    () => useMonthly ? aggregateByMonth(current) : aggregateByDay(current, maxDays),
    [current, useMonthly, maxDays]
  );
  const priorAgg = useMemo(
    () => useMonthly ? aggregateByMonth(prior) : aggregateByDay(prior, maxDays),
    [prior, useMonthly, maxDays]
  );

  const currentCosts = useMemo(
    () => computePeriodCosts(current, currentUnitRates, currentStandingRates, useMonthly),
    [current, currentUnitRates, currentStandingRates, useMonthly]
  );
  const priorCosts = useMemo(
    () => computePeriodCosts(prior, priorUnitRates, priorStandingRates, useMonthly),
    [prior, priorUnitRates, priorStandingRates, useMonthly]
  );

  const chartData = useMemo(
    () => mergePeriodsForChart(currentAgg, priorAgg, 'current', 'prior').map(d => ({
      ...d,
      currentCost: currentCosts[d.dateKey] ?? null,
      priorCost: priorCosts[d.dateKey] ?? null,
    })),
    [currentAgg, priorAgg, currentCosts, priorCosts]
  );

  const currentKwh = useMemo(() => current.reduce((s, r) => s + r.consumption, 0), [current]);
  const priorKwh = useMemo(() => prior.reduce((s, r) => s + r.consumption, 0), [prior]);
  const kwhDelta = priorKwh > 0 ? currentKwh - priorKwh : null;
  const kwhDeltaPct = priorKwh > 0 ? (kwhDelta! / priorKwh) * 100 : null;

  const costDelta = currentCost && priorCost
    ? currentCost.totalCostPence - priorCost.totalCostPence
    : null;

  const hasPrior = prior.length > 0;

  return (
    <div className="panel flex-col gap-3">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>{meter.label}</h3>
        {meter.activeSerial && (
          <span className="text-secondary" style={{ fontSize: '0.78rem' }}>
            Meter {meter.activeSerial}
          </span>
        )}
      </div>

      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '3rem 0', gap: '0.75rem' }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            border: '3px solid var(--border-color)',
            borderTopColor: 'var(--accent-color)',
            animation: 'spin 0.8s linear infinite',
          }} />
          <span className="text-secondary" style={{ fontSize: '0.85rem' }}>Loading…</span>
        </div>
      )}

      {error && (
        <div style={{ color: 'var(--error-color)', fontSize: '0.85rem' }}>{error}</div>
      )}

      {!loading && !error && current.length === 0 && (
        <div className="text-secondary text-center" style={{ padding: '2rem 0', fontSize: '0.87rem' }}>
          No data available for this period.
        </div>
      )}

      {!loading && current.length > 0 && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <SummaryCard
              label="Consumption"
              value={`${currentKwh.toFixed(1)} kWh`}
              sub={timeframeLabel(timeframe)}
              highlight
            />
            {currentCost && (
              <SummaryCard
                label={meter.isExport ? 'Revenue' : 'Cost'}
                value={penceToGBP(currentCost.totalCostPence)}
                sub={meter.isExport ? undefined : `inc. ${penceToGBP(currentCost.standingChargePence)} standing`}
                highlight
              />
            )}
            {currentCost && (
              <SummaryCard
                label="Effective Rate"
                value={`${currentCost.averagePencePerKwh.toFixed(1)}p/kWh`}
                sub="unit cost ÷ consumption"
              />
            )}
            {hasPrior && kwhDelta !== null && (
              <SummaryCard
                label={`vs ${priorPeriodLabel(timeframe)}`}
                value={
                  kwhDelta === 0 ? 'no change'
                  : meter.isExport
                    ? kwhDelta > 0 ? `${kwhDelta.toFixed(1)} kWh more` : `${Math.abs(kwhDelta).toFixed(1)} kWh less`
                    : kwhDelta < 0 ? `${Math.abs(kwhDelta).toFixed(1)} kWh less` : `${kwhDelta.toFixed(1)} kWh more`
                }
                sub={kwhDeltaPct !== null
                  ? `${Math.abs(kwhDeltaPct).toFixed(0)}% ${kwhDeltaPct > 0 ? 'more' : 'less'} kWh`
                  : undefined}
                delta={{
                  value: costDelta !== null
                    ? costDelta > 0 ? `${penceToGBP(costDelta)} more` : costDelta < 0 ? `${penceToGBP(Math.abs(costDelta))} less` : 'same'
                    : '',
                  // Import: lower kWh = good. Export: higher kWh = good.
                  positive: kwhDelta !== null
                    ? meter.isExport ? kwhDelta > 0 : kwhDelta < 0
                    : null,
                }}
              />
            )}
          </div>

          {/* Chart */}
          <div style={{ width: '100%', height: 240, minHeight: 240, overflow: 'hidden' }}>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: timeframe === '7days' ? 20 : 5 }} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                <XAxis
                  dataKey="date"
                  stroke="var(--text-secondary)"
                  interval={timeframe === '7days' ? 0 : 'preserveStartEnd'}
                  height={timeframe === '7days' ? 36 : 20}
                  tick={timeframe === '7days'
                    ? (makeDowTick(chartData as unknown as { date: string; dow: string }[]) as React.FC)
                    : { fontSize: 11 } as object
                  }
                />
                <YAxis stroke="var(--text-secondary)" tick={{ fontSize: 11 }} unit=" kWh" width={60} />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0]?.payload as Record<string, unknown> | undefined;
                    if (!d) return null;
                    const curKwh = d.current as number | null;
                    const prKwh = d.prior as number | null;
                    const curCost = d.currentCost as number | null;
                    const prCost = d.priorCost as number | null;
                    return (
                      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '0.5rem 0.75rem', fontSize: '0.85rem' }}>
                        <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{d.date as string}</div>
                        {curKwh != null && (
                          <div style={{ color: 'var(--accent-color)' }}>
                            {curKwh.toFixed(1)} kWh{curCost != null && <span style={{ marginLeft: '0.5rem', color: 'var(--text-primary)' }}>{penceToGBP(curCost)}</span>}
                          </div>
                        )}
                        {prKwh != null && prKwh > 0 && (
                          <div style={{ color: 'var(--chart-prior, rgba(255,255,255,0.25))' }}>
                            {prKwh.toFixed(1)} kWh{prCost != null && <span style={{ marginLeft: '0.5rem' }}>{penceToGBP(prCost)}</span>}
                            <span style={{ marginLeft: '0.3rem', fontSize: '0.78rem', opacity: 0.7 }}>(prior)</span>
                          </div>
                        )}
                      </div>
                    );
                  }}
                />
                {hasPrior && <Legend wrapperStyle={{ fontSize: '0.8rem' }} />}
                <Bar dataKey="current" name={timeframeLabel(timeframe)} fill="var(--chart-current)" radius={[3, 3, 0, 0]} />
                {hasPrior && <Bar dataKey="prior" name={priorPeriodLabel(timeframe)} fill="var(--chart-prior)" radius={[3, 3, 0, 0]} />}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------

export function Dashboard({ api }: DashboardProps) {
  const [account, setAccount] = useState<OctopusAccount | null>(null);
  const [givenName, setGivenName] = useState<string | null>(null);
  const [nameError, setNameError] = useState(false);
  const [meters, setMeters] = useState<MeterInfo[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [exportProducts, setExportProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);

  const [appView, setAppView] = useState<AppView>('usage');
  const [timeframe, setTimeframe] = useState<Timeframe>('30days');

  // Tracker view state
  const [trackerData, setTrackerData] = useState<TrackerData | null>(null);
  const trackerDataRef = React.useRef<TrackerData | null>(null);
  // Keep ref in sync so runAllComparisons can read latest trackerData without
  // being recreated every time trackerData changes
  trackerDataRef.current = trackerData;

  // The currently-live Tracker product — fetched for all users so the compare
  // view can show Tracker regardless of whether the user is currently on it.
  const [liveTrackerProduct, setLiveTrackerProduct] = useState<{ productCode: string; fullName: string } | null>(null);
  const liveTrackerProductRef = React.useRef<{ productCode: string; fullName: string } | null>(null);
  liveTrackerProductRef.current = liveTrackerProduct;

  // Full product catalogue (last 12+ months) and family grouping for rate chaining
  const productCatalogueRef = React.useRef<Product[]>([]);
  const familyMapRef = React.useRef<Map<string, Product[]>>(new Map());
  // Tracks the last timeframe+elecDataLength combo we fetched tracker data for — prevents double-fetches
  const lastTrackerFetchKey = React.useRef<string | null>(null);
  const [meterData, setMeterData] = useState<Record<string, MeterData>>({});

  // Cached tariff product name — survives baseline resets on period change
  const cachedProductFullName = React.useRef<Record<string, string | null>>({});

  // Compare view state
  const [compareMeterId, setCompareMeterId] = useState<string>('');
  /** Baseline keyed by meter ID — computed for every meter, not just electricity */
  const [baselines, setBaselines] = useState<Record<string, BaselineResult>>({});
  /** productCode → calculated result (undefined = not yet done, null = failed/unavailable) */
  const [altResults, setAltResults] = useState<Record<string, AltResult | null>>({});
  /** Lightweight counter used only for progress bar — avoids re-renders from altResults during run */
  const [completedCount, setCompletedCount] = useState(0);
  const [comparisonsRunning, setComparisonsRunning] = useState(false);
  type SortCol = 'name' | 'cost' | 'rate' | 'delta';
  const [sortCol, setSortCol] = useState<SortCol>('cost');
  // Will be corrected when compareMeterId is set; default true (cheapest first for import)
  const [sortAsc, setSortAsc] = useState(true);

  // -----------------------------------------------------------------------
  // Load account + products + resolve active serials
  // -----------------------------------------------------------------------

  useEffect(() => {
    async function init() {
      try {
        setLoading(true);
        const [accData, prodData, name, liveTracker, catalogue] = await Promise.all([
          api.getAccountDetails(),
          api.getProducts(),
          api.getViewerName(),
          api.findLiveTrackerProduct(),
          api.getProductCatalogue(),
        ]);
        productCatalogueRef.current = catalogue;
        familyMapRef.current = groupProductFamilies(catalogue);
        setLiveTrackerProduct(liveTracker);
        setGivenName(name);
        if (!name) setNameError(true);

        setAccount(accData);

        const meterList = buildMeterList(accData);

        // Resolve the active serial for each meter in parallel
        const resolved = await Promise.all(
          meterList.map(async m => {
            const active = await api.findActiveSerial(m.fuelType, m.id, m.serials);
            return { ...m, activeSerial: active };
          })
        );

        // Filter to meters with a working serial
        const usable = resolved.filter(m => m.activeSerial !== null);
        setMeters(usable);

        // Default compare meter to the first import electricity meter
        const importElec = usable.find(m => m.fuelType === 'electricity' && !m.isExport);
        setCompareMeterId(importElec?.id ?? usable[0]?.id ?? '');

        // Keep only import tariffs relevant for comparison:
        // - not business, not prepay
        // - exclude export/outgoing and SEG tariffs (no import consumption to compare against)
        // - exclude Zero Bills (restricted programme, not switchable)
        // - exclude Power Pack (bundled product, not a standard tariff)
        const EXCLUDE_PATTERN = /^(OUTGOING|AGILE-OUTGOING|.*-SEG-|.*-EO-|ZERO-EXPORT|ZERO-IMPORT|POWER-PACK|COOP-|CP-|LP-)/;
        const importProducts = prodData.results
          .filter(p =>
            !p.is_business &&
            !p.is_prepay &&
            !EXCLUDE_PATTERN.test(p.code)
          )
          .sort((a, b) => a.full_name.localeCompare(b.full_name));

        // Fetch product detail in parallel to get fuel availability flags
        const withFuelFlags = await Promise.all(
          importProducts.map(async p => {
            const detail = await api.getProductDetail(p.code);
            return {
              ...p,
              has_electricity: detail?.has_electricity ?? true,
              has_gas: detail?.has_gas ?? false,
            };
          })
        );

        setProducts(withFuelFlags);

        // Export products — Outgoing/SEG tariffs, excluding white-labels and Zero Bills
        const EXPORT_INCLUDE = /^(OUTGOING-|AGILE-OUTGOING)/;
        const exportProds = prodData.results
          .filter(p => !p.is_business && !p.is_prepay && EXPORT_INCLUDE.test(p.code))
          .sort((a, b) => a.full_name.localeCompare(b.full_name));
        setExportProducts(exportProds);
      } catch (err: unknown) {
        setInitError(err instanceof Error ? err.message : 'Unknown error loading account');
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [api]);

  // -----------------------------------------------------------------------
  // Fetch data for all meters whenever timeframe changes
  // -----------------------------------------------------------------------

  const fetchAllMeters = useCallback(async (
    meterList: MeterInfo[],
    tf: Timeframe,
    acct: OctopusAccount
  ) => {
    const property = acct.properties[0];
    const elecPoint = property?.electricity_meter_points?.find(m => !m.is_export);
    const mpan = elecPoint?.mpan ?? '';
    const regionLetter = mpan ? getGspFromMpan(mpan) : '_A';

    await Promise.all(meterList.map(async meter => {
      if (!meter.activeSerial) return;

      // Mark as loading
      setMeterData(prev => ({
        ...prev,
        [meter.id]: {
          meter, current: [], prior: [], latestDate: null,
          currentCost: null, priorCost: null,
          currentUnitRates: [], currentStandingRates: [],
          priorUnitRates: [], priorStandingRates: [],
          loading: true, error: null,
        },
      }));

      try {
        const latestStr = await api.getLatestConsumptionDate(meter.fuelType, meter.id, meter.activeSerial);
        if (!latestStr) {
          setMeterData(prev => ({
            ...prev,
            [meter.id]: { ...prev[meter.id], loading: false, error: 'No data available for this meter.' },
          }));
          return;
        }

        // Snap to local-midnight boundaries so we get exactly N complete local calendar days.
        // latestStr is the interval_end of the most recent slot (e.g. "2026-04-03T22:30:00Z" = 23:30 BST).
        // Parse into a local Date, then advance to the start of the *next* local day.
        // currentTo = start of the day AFTER the latest data day (exclusive upper bound).
        // currentFrom = exactly N days before that = N complete local calendar days of data.
        // e.g. latest data is 3 Apr → currentTo = 4 Apr 00:00, currentFrom = 28 Mar 00:00 → 7 days: 28,29,30,31 Mar + 1,2,3 Apr
        // interval_end is the exclusive end of the last slot, e.g. "2026-04-02T01:00:00+01:00"
        // = midnight BST = start of Apr 2, meaning the last slot DATA is from Apr 1.
        // Subtract 1ms to land inside the last data day.
        const lastDataMs = new Date(latestStr).getTime() - 1;
        const latestDay = new Date(lastDataMs);
        const days = timeframeDays(tf);
        // currentTo = start of the day after the last data day (exclusive upper bound for API)
        const currentTo = new Date(latestDay.getFullYear(), latestDay.getMonth(), latestDay.getDate() + 1);
        const currentFrom = new Date(currentTo.getFullYear(), currentTo.getMonth(), currentTo.getDate() - days);
        const priorTo = currentFrom;
        const priorFrom = new Date(priorTo.getFullYear(), priorTo.getMonth(), priorTo.getDate() - days);
        const latestDate = latestDay;

        const [currentData, priorData] = await Promise.all([
          meter.fuelType === 'electricity'
            ? api.getElectricityConsumption(meter.id, meter.activeSerial, currentFrom.toISOString(), currentTo.toISOString())
            : api.getGasConsumption(meter.id, meter.activeSerial, currentFrom.toISOString(), currentTo.toISOString()),
          meter.fuelType === 'electricity'
            ? api.getElectricityConsumption(meter.id, meter.activeSerial, priorFrom.toISOString(), priorTo.toISOString())
            : api.getGasConsumption(meter.id, meter.activeSerial, priorFrom.toISOString(), priorTo.toISOString()),
        ]);

        // Compute costs using historical agreements for each portion of the period
        let currentCost: CostCalculation | null = null;
        let priorCost: CostCalculation | null = null;
        let curUnitRates: Rate[] = [];
        let curStandingRates: Rate[] = [];
        let prUnitRates: Rate[] = [];
        let prStandingRates: Rate[] = [];

        if (meter.point.agreements?.length && currentData.length > 0) {
          const sortedCurrent = [...currentData].sort((a, b) => new Date(a.interval_start).getTime() - new Date(b.interval_start).getTime());
          const periodFrom = toUtcIso(sortedCurrent[0].interval_start);
          const periodTo = toUtcIso(sortedCurrent[sortedCurrent.length - 1].interval_end);

          try {
            [curUnitRates, curStandingRates] = await Promise.all([
              fetchCombinedAgreementRates(api, meter.point.agreements, meter.fuelType, periodFrom, periodTo, 'unit'),
              fetchCombinedAgreementRates(api, meter.point.agreements, meter.fuelType, periodFrom, periodTo, 'standing'),
            ]);
            currentCost = CostEngine.calculateCost(currentData, curUnitRates, curStandingRates);
          } catch {
            // Cost calculation failed — show usage data without cost
          }
        }

        if (meter.point.agreements?.length && priorData.length > 0) {
          const priorSortedData = [...priorData].sort((a, b) => new Date(a.interval_start).getTime() - new Date(b.interval_start).getTime());
          const priorPeriodFrom = toUtcIso(priorSortedData[0].interval_start);
          const priorPeriodTo = toUtcIso(priorSortedData[priorSortedData.length - 1].interval_end);

          try {
            [prUnitRates, prStandingRates] = await Promise.all([
              fetchCombinedAgreementRates(api, meter.point.agreements, meter.fuelType, priorPeriodFrom, priorPeriodTo, 'unit'),
              fetchCombinedAgreementRates(api, meter.point.agreements, meter.fuelType, priorPeriodFrom, priorPeriodTo, 'standing'),
            ]);
            priorCost = CostEngine.calculateCost(priorData, prUnitRates, prStandingRates);
          } catch {
            // Prior cost unavailable
          }
        }

        // Compute baseline for every meter (import electricity, gas, and export)
        if (currentData.length > 0) {
          const agreement = getActiveAgreement(meter.point.agreements);
          if (agreement) {
            const tariffCode = agreement.tariff_code;
            const productCode = productCodeFromTariffCode(tariffCode);
            const sortedCurrent = [...currentData].sort((a, b) => new Date(a.interval_start).getTime() - new Date(b.interval_start).getTime());
            const periodFrom = toUtcIso(sortedCurrent[0].interval_start);
            const periodTo = toUtcIso(sortedCurrent[sortedCurrent.length - 1].interval_end);

            try {
              const [unitRates, standingCharges] = await Promise.all([
                fetchCombinedAgreementRates(api, meter.point.agreements, meter.fuelType, periodFrom, periodTo, 'unit'),
                fetchCombinedAgreementRates(api, meter.point.agreements, meter.fuelType, periodFrom, periodTo, 'standing'),
              ]);
              const current = CostEngine.calculateCost(currentData, unitRates, standingCharges);
              // No Ofgem cap for export meters
              const ofgem = meter.isExport
                ? { unitCostPence: 0, standingChargePence: 0, totalCostPence: 0, totalConsumptionKwh: 0, averagePencePerKwh: 0, periodDays: current.periodDays }
                : calculateOfgemCapCost(currentData, regionLetter, meter.fuelType);
              const inList = [...products, ...exportProducts].find(p => p.code === productCode);
              const productFullName = inList?.full_name
                ?? (await api.getProductDetail(productCode))?.full_name
                ?? null;
              if (productFullName) cachedProductFullName.current[meter.id] = productFullName;
              setBaselines(prev => ({
                ...prev,
                [meter.id]: { current, ofgem, tariffCode, productCode, productFullName, regionLetter },
              }));
            } catch {
              // baseline unavailable for this meter
            }
          }
        }

        setMeterData(prev => ({
          ...prev,
          [meter.id]: {
            meter, current: currentData, prior: priorData,
            latestDate, currentCost, priorCost,
            currentUnitRates: curUnitRates, currentStandingRates: curStandingRates,
            priorUnitRates: prUnitRates, priorStandingRates: prStandingRates,
            loading: false, error: null,
          },
        }));
      } catch (err: unknown) {
        setMeterData(prev => ({
          ...prev,
          [meter.id]: {
            ...prev[meter.id],
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load data',
          },
        }));
      }
    }));
  }, [api]);

  useEffect(() => {
    if (meters.length === 0 || !account) return;
    setAltResults({});
    setBaselines({});
    // Immediately mark all meters as loading with empty data so charts blank out
    // before the new period's data arrives — prevents stale data flicker
    setMeterData(
      Object.fromEntries(meters.map(m => [m.id, {
        meter: m, current: [], prior: [], latestDate: null,
        currentCost: null, priorCost: null,
        currentUnitRates: [], currentStandingRates: [],
        priorUnitRates: [], priorStandingRates: [],
        loading: true, error: null,
      }]))
    );
    fetchAllMeters(meters, timeframe, account);
  }, [meters, timeframe, account, fetchAllMeters]);

  // Auto-run all comparisons when the baseline for the selected compare meter is ready
  useEffect(() => {
    const bl = baselines[compareMeterId];
    if (!bl) return;
    const meter = meters.find(m => m.id === compareMeterId);
    const mData = meterData[compareMeterId];
    if (!meter || !mData?.current.length) return;
    setAltResults({});
    runAllComparisons(meter, mData.current, bl);
  }, [baselines, compareMeterId]); // eslint-disable-line react-hooks/exhaustive-deps

  // -----------------------------------------------------------------------
  // Tracker view: fetch daily rates + SVT comparison
  // -----------------------------------------------------------------------

  const fetchTrackerData = useCallback(async (
    elecAgreements: Agreement[],
    regionLetter: string,
    tf: Timeframe,
    elecConsumption: ConsumptionResult[],
    gasConsumption: ConsumptionResult[],
    gasAgreements: Agreement[] | null,
  ) => {
    setTrackerData(prev => ({
      ...(prev ?? {
        loading: true, error: null,
        electricity: { rates: [], svtRates: [], trackerCost: null, svtCost: null },
        gas: null, svtProductCode: null, currentTrackerProduct: null,
      }),
      loading: true, error: null,
    }));

    try {
      const now = new Date();
      const days = timeframeDays(tf);
      const rateFromLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
      const rateToLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
      const rateFromIso = rateFromLocal.toISOString();
      const rateToIso = rateToLocal.toISOString();
      const rateFromKey = localDateKey(rateFromLocal);

      // Find the VAR (Flexible) product family from the catalogue for chained
      // rate comparison.  Falls back to the well-known VAR-22-11-01 if the
      // catalogue hasn't loaded yet.
      const varFamily = familyMapRef.current.get('VAR-') ?? [];
      const varProduct = varFamily.find(p => !p.available_to) ?? varFamily[varFamily.length - 1] ?? null;
      const SVT_PRODUCT = varProduct?.code ?? 'VAR-22-11-01';

      // Derive the active product code from the latest electricity agreement
      const activeElecAgreement = getActiveAgreement(elecAgreements);
      const activeProductCode = activeElecAgreement
        ? productCodeFromTariffCode(activeElecAgreement.tariff_code)
        : '';

      /** Convert raw API rate entries to sorted TrackerDayRate[].
       *  Tracker rates have valid_from at 23:00 UTC (= midnight BST/local).
       *  We use the local date of valid_to (the end of the rate period) as the
       *  "day" this rate applies to — that's the local calendar day it covers. */
      const toTrackerRates = (raw: { value_inc_vat: number; valid_from: string; valid_to: string | null }[]): TrackerDayRate[] =>
        raw
          .map(r => {
            // valid_to is 23:00 UTC the next day = midnight local the day after.
            // Subtract 1ms to land inside the correct local day.
            const representativeDate = r.valid_to
              ? new Date(new Date(r.valid_to).getTime() - 1)
              : new Date(new Date(r.valid_from).getTime() + 86400_000 - 1);
            const dateKey = localDateKey(representativeDate);
            return {
              date: dateKey,
              label: representativeDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
              rateIncVat: r.value_inc_vat,
              valid_from: r.valid_from,
            };
          })
          .filter(r => r.date >= rateFromKey)
          .sort((a, b) => a.date.localeCompare(b.date));

      /** Fetch rates + SVT rates + costs for one fuel.
       *  Uses chained rate fetching for the Flexible product so that if its
       *  rates don't cover the full comparison period (e.g. after a quarterly
       *  product code change), the predecessor product's rates fill the gap. */
      const fetchFuelData = async (
        fuelType: 'electricity' | 'gas',
        agreements: Agreement[],
        consumption: ConsumptionResult[],
      ): Promise<TrackerFuelData> => {
        const [trackerRates, svtRatesRaw] = await Promise.all([
          fetchCombinedAgreementRates(api, agreements, fuelType, rateFromIso, rateToIso, 'unit'),
          varFamily.length > 0
            ? api.fetchFamilyChainedRates(varFamily, regionLetter, fuelType, rateFromIso, rateToIso, 'unit', null)
            : api.fetchUnitRates(SVT_PRODUCT, `${fuelType === 'electricity' ? 'E' : 'G'}-1R-${SVT_PRODUCT}-${regionLetter.replace('_', '')}`, fuelType, rateFromIso, rateToIso),
        ]);

        const rates = toTrackerRates(trackerRates);
        // Keep the full SVT rate history, sorted oldest-first for date-range lookup
        const svtRates: SvtRateEntry[] = svtRatesRaw
          .map(r => ({ valid_from: r.valid_from, valid_to: r.valid_to, value_inc_vat: r.value_inc_vat }))
          .sort((a, b) => new Date(a.valid_from).getTime() - new Date(b.valid_from).getTime());

        let trackerCost: CostCalculation | null = null;
        let svtCost: CostCalculation | null = null;

        if (consumption.length > 0) {
          const sorted = [...consumption].sort((a, b) => new Date(a.interval_start).getTime() - new Date(b.interval_start).getTime());
          const periodFrom = toUtcIso(sorted[0].interval_start);
          const periodTo = toUtcIso(sorted[sorted.length - 1].interval_end);

          const [tRates, tSC, sRates, sSC] = await Promise.all([
            fetchCombinedAgreementRates(api, agreements, fuelType, periodFrom, periodTo, 'unit'),
            fetchCombinedAgreementRates(api, agreements, fuelType, periodFrom, periodTo, 'standing'),
            varFamily.length > 0
              ? api.fetchFamilyChainedRates(varFamily, regionLetter, fuelType, periodFrom, periodTo, 'unit', null)
              : api.fetchUnitRates(SVT_PRODUCT, `${fuelType === 'electricity' ? 'E' : 'G'}-1R-${SVT_PRODUCT}-${regionLetter.replace('_', '')}`, fuelType, periodFrom, periodTo),
            varFamily.length > 0
              ? api.fetchFamilyChainedRates(varFamily, regionLetter, fuelType, periodFrom, periodTo, 'standing', null)
              : api.fetchStandingCharges(SVT_PRODUCT, `${fuelType === 'electricity' ? 'E' : 'G'}-1R-${SVT_PRODUCT}-${regionLetter.replace('_', '')}`, fuelType, periodFrom, periodTo),
          ]);

          trackerCost = CostEngine.calculateCost(consumption, tRates, tSC);
          svtCost = CostEngine.calculateCost(consumption, sRates, sSC);
        }

        return { rates, svtRates, trackerCost, svtCost };
      };

      // Fetch electricity + gas (if available) + current Tracker version in parallel
      const [electricity, gasResult, currentTracker] = await Promise.all([
        fetchFuelData('electricity', elecAgreements, elecConsumption),
        gasAgreements
          ? fetchFuelData('gas', gasAgreements, gasConsumption)
          : Promise.resolve(null),
        api.findCurrentTrackerProduct(activeProductCode, regionLetter, 'electricity'),
      ]);

      setTrackerData({
        loading: false,
        error: null,
        electricity,
        gas: gasResult,
        svtProductCode: SVT_PRODUCT,
        currentTrackerProduct: currentTracker,
      });
    } catch (err) {
      setTrackerData(prev => ({
        ...(prev ?? {
          electricity: { rates: [], svtRates: [], trackerCost: null, svtCost: null },
          gas: null, svtProductCode: null, currentTrackerProduct: null,
        }),
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load Tracker data',
      }));
    }
  }, [api]);

  // Effect 1: detect Tracker tariff once meters are known — set default view only.
  // Does NOT depend on meterData so it won't re-run on every consumption reload.
  useEffect(() => {
    const importElec = meters.find(m => m.fuelType === 'electricity' && !m.isExport);
    if (!importElec) return;
    const elecAgreement = getActiveAgreement(importElec.point.agreements);
    if (!elecAgreement) return;
    if (!isTrackerProductCode(productCodeFromTariffCode(elecAgreement.tariff_code))) return;
    setAppView(v => v === 'usage' ? 'tracker' : v);
  }, [meters]); // eslint-disable-line react-hooks/exhaustive-deps

  // Effect 2: fetch Tracker data once all meters have finished loading.
  // Uses a ref-based key to ensure we only fetch once per timeframe+data combination.
  useEffect(() => {
    const importElec = meters.find(m => m.fuelType === 'electricity' && !m.isExport);
    if (!importElec) return;
    const elecAgreement = getActiveAgreement(importElec.point.agreements);
    if (!elecAgreement) return;
    const productCode = productCodeFromTariffCode(elecAgreement.tariff_code);
    if (!isTrackerProductCode(productCode)) return;

    // Wait until every meter entry is present and none are loading
    const allEntries = Object.values(meterData);
    if (allEntries.length === 0) return;
    if (allEntries.some(d => d.loading)) return;

    const elecData = meterData[importElec.id];
    if (!elecData || elecData.current.length === 0) return;

    const gasMeter = meters.find(m => m.fuelType === 'gas' && !m.isExport);
    const gasHasTracker = gasMeter?.point.agreements?.some(ag =>
      isTrackerProductCode(productCodeFromTariffCode(ag.tariff_code))
    ) ?? false;
    const gasMeterData = gasHasTracker && gasMeter ? meterData[gasMeter.id] : null;

    // Build a stable key: timeframe + elec data length + gas data length
    // This ensures we only re-fetch when the actual data has changed, not on unrelated meterData updates
    const fetchKey = `${timeframe}:${elecData.current.length}:${gasMeterData?.current.length ?? 0}`;
    if (lastTrackerFetchKey.current === fetchKey) return;
    lastTrackerFetchKey.current = fetchKey;

    const property = account?.properties[0];
    const mpan = property?.electricity_meter_points?.find(m => !m.is_export)?.mpan ?? '';
    const regionLetter = mpan ? getGspFromMpan(mpan) : '_A';

    fetchTrackerData(
      importElec.point.agreements ?? [],
      regionLetter,
      timeframe,
      elecData.current,
      gasMeterData?.current ?? [],
      gasHasTracker ? (gasMeter!.point.agreements ?? null) : null,
    );
  }, [meterData]); // eslint-disable-line react-hooks/exhaustive-deps

  // -----------------------------------------------------------------------
  // Compare view: compute all available tariffs in parallel
  // -----------------------------------------------------------------------

  const runAllComparisons = useCallback(async (
    meter: MeterInfo,
    consumption: ConsumptionResult[],
    bl: BaselineResult
  ) => {
    const productList = meter.isExport ? exportProducts : products;
    if (!consumption.length || !productList.length) return;

    setComparisonsRunning(true);
    setAltResults({});
    setCompletedCount(0);

    const sorted = [...consumption].sort(
      (a, b) => new Date(a.interval_start).getTime() - new Date(b.interval_start).getTime()
    );
    const periodFrom = toUtcIso(sorted[0].interval_start);
    const periodTo = toUtcIso(sorted[sorted.length - 1].interval_end);
    const regionChar = bl.regionLetter.replace('_', '');

    // For export meters use the export product list directly;
    // for import meters filter by fuel type
    const compatibleProducts = meter.isExport
      ? productList
      : productList.filter(p => meter.fuelType === 'gas' ? p.has_gas : p.has_electricity);

    // Inject the live Tracker product for cost calculation if it's not already in the
    // standard product list. Use a ref so this callback doesn't need to be recreated
    // whenever liveTrackerProduct state changes.
    const extraProducts: Array<{ code: string; full_name: string; tariffCode: string }> = [];
    if (!meter.isExport && liveTrackerProductRef.current) {
      const lt = liveTrackerProductRef.current;
      if (!compatibleProducts.find(p => p.code === lt.productCode)) {
        const fuelPrefix = meter.fuelType === 'gas' ? 'G' : 'E';
        const tariffCode = `${fuelPrefix}-1R-${lt.productCode}-${regionChar}`;
        extraProducts.push({ code: lt.productCode, full_name: lt.fullName, tariffCode });
      }
    }

    // Accumulate all results locally; only the cheap counter triggers re-renders during the run.
    // A single setAltResults call at the end commits everything at once.
    const accumulated: Record<string, AltResult | null> = {};

    /** For a partial-period result, compute the current tariff's cost over the same covered slots */
    const computeCurrentForSamePeriod = async (altCalc: CostCalculation): Promise<CostCalculation | null> => {
      if (!altCalc.coveredFrom || !altCalc.coveredTo) return null;
      const coveredSlots = consumption.filter(s => {
        const t = new Date(s.interval_start).getTime();
        return t >= new Date(altCalc.coveredFrom!).getTime() && t < new Date(altCalc.coveredTo!).getTime();
      });
      if (!coveredSlots.length) return null;
      try {
        const [curRates, curSC] = await Promise.all([
          fetchCombinedAgreementRates(api, meter.point.agreements, meter.fuelType, altCalc.coveredFrom, altCalc.coveredTo, 'unit'),
          fetchCombinedAgreementRates(api, meter.point.agreements, meter.fuelType, altCalc.coveredFrom, altCalc.coveredTo, 'standing'),
        ]);
        return CostEngine.calculateCost(coveredSlots, curRates, curSC);
      } catch {
        return null;
      }
    };

    // Resolve the VAR (Flexible) product from the family map — used as the
    // fallback for gaps in other families' timelines.
    const varFamily = familyMapRef.current.get('VAR-');
    const varProduct = varFamily?.find(p => !p.available_to) ?? varFamily?.[varFamily.length - 1] ?? null;

    const standardTasks = compatibleProducts.map(async product => {
      try {
        // Look up the product's family from the catalogue for chained rate fetching
        const prefix = productFamilyPrefix(product.code);
        const family = familyMapRef.current.get(prefix);

        let unitRates, standingCharges;
        if (family && family.length > 0) {
          // Use family-chained fetching — covers predecessor products automatically
          [unitRates, standingCharges] = await Promise.all([
            api.fetchFamilyChainedRates(family, bl.regionLetter, meter.fuelType, periodFrom, periodTo, 'unit', varProduct),
            api.fetchFamilyChainedRates(family, bl.regionLetter, meter.fuelType, periodFrom, periodTo, 'standing', varProduct),
          ]);
        } else {
          // Fallback: product not in catalogue (shouldn't happen, but be safe)
          const tariffCode = meter.fuelType === 'gas'
            ? `G-1R-${product.code}-${regionChar}`
            : `E-1R-${product.code}-${regionChar}`;
          [unitRates, standingCharges] = await Promise.all([
            CostEngine.fetchTariffRates(api, product.code, tariffCode, meter.fuelType, periodFrom, periodTo),
            CostEngine.fetchStandingCharges(api, product.code, tariffCode, meter.fuelType, periodFrom, periodTo),
          ]);
        }
        const result = CostEngine.calculateCost(consumption, unitRates, standingCharges);
        const fullDays = bl.current.periodDays || 1;
        const isPartial = (result.periodDays || 1) < fullDays - 1;
        const currentForSamePeriod = isPartial ? await computeCurrentForSamePeriod(result) : null;
        accumulated[product.code] = { result, currentForSamePeriod };
      } catch {
        accumulated[product.code] = null;
      }
      setCompletedCount(c => c + 1);
    });

    // Extra products (e.g. live Tracker) — not in the public catalogue, so
    // use direct rate fetching (no family chaining needed for Tracker)
    const extraTasks = extraProducts.map(async product => {
      try {
        const [unitRates, standingCharges] = await Promise.all([
          CostEngine.fetchTariffRates(api, product.code, product.tariffCode, meter.fuelType, periodFrom, periodTo),
          CostEngine.fetchStandingCharges(api, product.code, product.tariffCode, meter.fuelType, periodFrom, periodTo),
        ]);
        const result = CostEngine.calculateCost(consumption, unitRates, standingCharges);
        const fullDays = bl.current.periodDays || 1;
        const isPartial = (result.periodDays || 1) < fullDays - 1;
        const currentForSamePeriod = isPartial ? await computeCurrentForSamePeriod(result) : null;
        accumulated[product.code] = { result, currentForSamePeriod };
      } catch {
        accumulated[product.code] = null;
      }
      setCompletedCount(c => c + 1);
    });

    await Promise.all([...standardTasks, ...extraTasks]);

    // Single state update — one re-render to show the completed table
    setAltResults(accumulated);
    setComparisonsRunning(false);
  }, [api, products, exportProducts]); // eslint-disable-line react-hooks/exhaustive-deps

  // -----------------------------------------------------------------------
  // Derived
  // -----------------------------------------------------------------------

  const property = account?.properties[0];
  const importElec = meters.find(m => m.fuelType === 'electricity' && !m.isExport);
  const activeTariffCode = useMemo(
    () => getActiveAgreement(importElec?.point.agreements)?.tariff_code ?? null,
    [importElec]
  );
  // Full name from baseline once computed, otherwise fall back to tariff code
  const currentTariffName = useMemo(() => {
    if (!importElec) return null;
    const bl = baselines[importElec.id];
    const fullName = bl?.productFullName ?? cachedProductFullName.current[importElec.id] ?? null;
    if (fullName) return { full: fullName, code: activeTariffCode };
    if (activeTariffCode) return { full: null, code: activeTariffCode };
    return null;
  }, [importElec, baselines, activeTariffCode]);

  const anyLoading = Object.values(meterData).some(d => d.loading);

  // Memoised compare table data — recomputed only when altResults, sort, or product lists change
  const compareMeter = useMemo(
    () => meters.find(m => m.id === compareMeterId),
    [meters, compareMeterId]
  );
  const compareIsExport = compareMeter?.isExport ?? false;
  const compareFuelType = compareMeter?.fuelType ?? 'electricity';
  const activeProductList = useMemo(() => {
    const base = compareIsExport
      ? exportProducts
      : products.filter(p => compareFuelType === 'gas' ? p.has_gas : p.has_electricity);
    // Inject the live Tracker product if it's not already in the public product list.
    // We always do this regardless of whether the user is currently on Tracker —
    // Tracker products don't appear in the public /products/ API response.
    if (!compareIsExport && liveTrackerProduct) {
      if (!base.find(p => p.code === liveTrackerProduct.productCode)) {
        return [...base, {
          code: liveTrackerProduct.productCode,
          full_name: liveTrackerProduct.fullName,
          display_name: 'Octopus Tracker',
          description: '',
          is_variable: true,
          is_green: false,
          is_tracker: true,
          is_prepay: false,
          is_business: false,
          has_electricity: true,
          has_gas: true,
        }];
      }
    }
    return base;
  }, [compareIsExport, compareFuelType, products, exportProducts, liveTrackerProduct]);

  const sortedCompareRows = useMemo(() => {
    // Exclude the user's current tariff — it's already shown as the pinned "current" row
    const currentProductCode = baselines[compareMeterId]?.productCode;
    const rows = activeProductList
      .filter(p => p.code !== currentProductCode)
      .map(p => ({
        code: p.code,
        name: p.full_name,
        altResult: altResults[p.code] as AltResult | null | undefined,
      }));
    return rows.sort((a, b) => {
      const aA = a.altResult, bA = b.altResult;
      if (!aA && !bA) return 0;
      if (!aA) return 1;
      if (!bA) return -1;
      const aR = aA.result, bR = bA.result;
      const baseline = baselines[compareMeterId];
      const hasBaseline = baseline?.tariffCode !== 'Unknown';
      const fullDays = baseline?.current.periodDays || 1;
      // Compare on daily cost so partial-coverage tariffs sort fairly
      const dailyCostA = aR.totalCostPence / Math.max(aR.periodDays || 1, 1);
      const dailyCostB = bR.totalCostPence / Math.max(bR.periodDays || 1, 1);
      let diff = 0;
      if (sortCol === 'name') diff = a.name.localeCompare(b.name);
      else if (sortCol === 'cost') diff = dailyCostA - dailyCostB;
      else if (sortCol === 'rate') diff = aR.averagePencePerKwh - bR.averagePencePerKwh;
      else if (sortCol === 'delta') {
        // Use actual current-tariff cost for partial tariffs, otherwise daily average
        const baselinePenceA = hasBaseline
          ? (aA.currentForSamePeriod?.totalCostPence ?? (baseline.current.totalCostPence / fullDays) * Math.max(aR.periodDays || 1, 1))
          : 0;
        const baselinePenceB = hasBaseline
          ? (bA.currentForSamePeriod?.totalCostPence ?? (baseline.current.totalCostPence / fullDays) * Math.max(bR.periodDays || 1, 1))
          : 0;
        diff = (aR.totalCostPence - baselinePenceA) - (bR.totalCostPence - baselinePenceB);
      }
      return sortAsc ? diff : -diff;
    });
  }, [activeProductList, altResults, sortCol, sortAsc, baselines, compareMeterId]);

  // O(N) single pass to find the best product code — uses daily cost for fair partial comparison
  const bestProductCode = useMemo(() => {
    const resolved = sortedCompareRows.filter(r => r.altResult != null) as Array<{ code: string; name: string; altResult: AltResult }>;
    if (!resolved.length) return null;
    const baseline = baselines[compareMeterId];
    if (!baseline) return null;
    const fullDays = baseline.current.periodDays || 1;
    const dailyCost = (r: CostCalculation) => r.totalCostPence / Math.max(r.periodDays || 1, 1);
    const baselineDaily = baseline.current.totalCostPence / fullDays;
    const best = compareIsExport
      ? resolved.reduce((a, b) => dailyCost(a.altResult.result) >= dailyCost(b.altResult.result) ? a : b)
      : resolved.reduce((a, b) => dailyCost(a.altResult.result) <= dailyCost(b.altResult.result) ? a : b);
    // For partial tariffs, compare against the actual current-tariff cost for the same window
    const bestCurrentPencePerDay = best.altResult.currentForSamePeriod
      ? best.altResult.currentForSamePeriod.totalCostPence / Math.max(best.altResult.currentForSamePeriod.periodDays || 1, 1)
      : baselineDaily;
    const delta = dailyCost(best.altResult.result) - bestCurrentPencePerDay;
    if (compareIsExport && delta <= 0) return null;
    if (!compareIsExport && delta >= 0) return null;
    return best.code;
  }, [sortedCompareRows, baselines, compareMeterId, compareIsExport]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (loading) {
    return (
      <div className="panel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '3rem 0', gap: '0.75rem' }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          border: '3px solid var(--border-color)',
          borderTopColor: 'var(--accent-color)',
          animation: 'spin 0.8s linear infinite',
        }} />
        <span className="text-secondary" style={{ fontSize: '0.85rem' }}>Connecting to your account…</span>
      </div>
    );
  }
  if (initError) {
    return <div className="panel"><h3 style={{ color: 'var(--error-color)' }}>Connection Error</h3><p>{initError}</p></div>;
  }
  if (!account) return null;

  return (
    <div className="flex-col gap-4">

      {/* ------------------------------------------------------------------ */}
      {/* Account header                                                      */}
      {/* ------------------------------------------------------------------ */}
      <div className="panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h2 style={{ margin: 0 }}>
            {givenName ? `Hi ${givenName}` : `Account ${account.number}`}
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', marginTop: '0.2rem' }}>
            <p className="text-secondary" style={{ margin: 0, fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              {givenName && <span>{account.number}</span>}
              {givenName && property?.address_line_1 && <span style={{ opacity: 0.4 }}>·</span>}
              {property?.address_line_1 && (
                <span>{[property.address_line_1, property.address_line_3, property.town].filter(Boolean).join(', ')}</span>
              )}
              {nameError && (
                <span title="Could not retrieve your name from the Octopus GraphQL API — check browser console for details"
                  style={{ opacity: 0.5, cursor: 'help', fontSize: '0.75rem' }}>
                  (name unavailable ⚠)
                </span>
              )}
            </p>
            {currentTariffName && (
              <span className="text-secondary" style={{ fontSize: '0.85rem' }}>
                Tariff:{' '}
                <strong style={{ color: 'var(--text-primary)' }}>
                  {currentTariffName.full ?? currentTariffName.code}
                </strong>
                {currentTariffName.full && currentTariffName.code && (
                  <span style={{ marginLeft: '0.4rem', fontSize: '0.78rem', opacity: 0.6 }}>
                    ({currentTariffName.code})
                  </span>
                )}
              </span>
            )}
          </div>
        </div>

        {/* View switcher */}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {trackerData !== null && (
            <button
              onClick={() => setAppView('tracker')}
              style={{
                opacity: appView === 'tracker' ? 1 : 0.5,
                background: appView === 'tracker' ? 'var(--accent-color)' : 'var(--input-bg)',
                color: appView === 'tracker' ? '#fff' : 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px', padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.9rem',
              }}
            >
              Tracker
            </button>
          )}
          <button
            onClick={() => setAppView('usage')}
            style={{
              opacity: appView === 'usage' ? 1 : 0.5,
              background: appView === 'usage' ? 'var(--accent-color)' : 'var(--input-bg)',
              color: appView === 'usage' ? '#fff' : 'var(--text-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: '6px', padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.9rem',
            }}
          >
            Usage
          </button>
          <button
            onClick={() => setAppView('compare')}
            style={{
              opacity: appView === 'compare' ? 1 : 0.5,
              background: appView === 'compare' ? 'var(--accent-color)' : 'var(--input-bg)',
              color: appView === 'compare' ? '#fff' : 'var(--text-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: '6px', padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.9rem',
            }}
          >
            Compare
          </button>
        </div>
      </div>

      {/* Timeframe selector */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          {(['7days', '30days', '1year'] as Timeframe[]).map(tf => (
            <button
              key={tf}
              onClick={() => {
                setTimeframe(tf);
                setTrackerData(prev => prev ? { ...prev, loading: true } : null);
              }}
              style={{
                padding: '0.35rem 0.85rem', fontSize: '0.85rem', borderRadius: '6px',
                cursor: 'pointer', border: '1px solid var(--border-color)',
                background: timeframe === tf ? 'var(--accent-color)' : 'var(--input-bg)',
                color: timeframe === tf ? '#fff' : 'var(--text-primary)',
              }}
            >
              {tf === '7days' ? '7 days' : tf === '30days' ? '30 days' : '12 months'}
            </button>
          ))}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* TRACKER VIEW                                                        */}
      {/* ------------------------------------------------------------------ */}
      {appView === 'tracker' && trackerData && activeTariffCode && (
        <TrackerPanel data={trackerData} timeframe={timeframe} />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* USAGE VIEW                                                          */}
      {/* ------------------------------------------------------------------ */}
      {appView === 'usage' && (
        <>
          {anyLoading && Object.keys(meterData).length === 0 && (
            <div className="panel text-center text-secondary" style={{ padding: '3rem' }}>
              Loading meter data…
            </div>
          )}

          {/* One panel per meter */}
          {meters.map(meter => {
            const data = meterData[meter.id];
            if (!data) return null;
            return <MeterPanel key={meter.id} data={data} timeframe={timeframe} />;
          })}
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* COMPARE VIEW                                                        */}
      {/* ------------------------------------------------------------------ */}
      {appView === 'compare' && (
        <div className="panel flex-col gap-3">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
            <div>
              <h2 style={{ margin: '0 0 0.25rem 0' }}>Tariff Comparison</h2>
              <p className="text-secondary" style={{ margin: 0, fontSize: '0.87rem' }}>
                Your actual consumption applied to every available tariff. Click a column header to sort.
              </p>
            </div>
            {/* Meter selector */}
            <div className="flex-col gap-1" style={{ flex: '0 0 auto' }}>
              <label className="text-secondary" style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Meter</label>
              <select
                value={compareMeterId}
                onChange={e => {
                  const newId = e.target.value;
                  const newMeter = meters.find(m => m.id === newId);
                  setCompareMeterId(newId);
                  setAltResults({});
                  // Export: sort highest rate first (most revenue); import: cheapest first
                  setSortCol('cost');
                  setSortAsc(!newMeter?.isExport);
                }}
                style={{ padding: '0.5rem' }}
              >
                {meters.map(m => (
                  <option key={m.id} value={m.id}>{m.label}: {m.id}</option>
                ))}
              </select>
            </div>
          </div>

          {/* No data yet */}
          {!baselines[compareMeterId] && meterData[compareMeterId]?.current.length === 0 && !anyLoading && (
            <p className="text-secondary" style={{ fontSize: '0.87rem' }}>
              No consumption data for this meter. Switch to Usage view and ensure data is available.
            </p>
          )}
          {!baselines[compareMeterId] && (meterData[compareMeterId]?.loading || anyLoading) && (
            <p className="text-secondary" style={{ fontSize: '0.87rem' }}>Loading consumption and baseline…</p>
          )}

          {/* The table */}
          {baselines[compareMeterId] && (() => {
            const baseline = baselines[compareMeterId];
            const isExportMeter = compareIsExport;
            const totalCount = activeProductList.length;
            const hasCurrentBaseline = baseline.tariffCode !== 'Unknown';
            const sorted = sortedCompareRows;

            // Sort helper
            const handleSort = (col: SortCol) => {
              if (sortCol === col) setSortAsc(a => !a);
              else { setSortCol(col); setSortAsc(true); }
            };
            const SortIndicator = ({ col }: { col: SortCol }) => (
              <span style={{ marginLeft: '0.3rem', opacity: sortCol === col ? 1 : 0.3, fontSize: '0.7rem' }}>
                {sortCol === col ? (sortAsc ? '▲' : '▼') : '▲'}
              </span>
            );

            // Column header style
            const thStyle = (col: SortCol): React.CSSProperties => ({
              textAlign: col === 'name' ? 'left' : 'right',
              cursor: 'pointer',
              userSelect: 'none',
              padding: '0.5rem 0.75rem',
              fontSize: '0.72rem',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: sortCol === col ? 'var(--text-primary)' : 'var(--text-secondary)',
              whiteSpace: 'nowrap',
              background: 'var(--bg-color)',
            });

            const cellStyle = (right = false): React.CSSProperties => ({
              padding: '0.55rem 0.75rem',
              textAlign: right ? 'right' : 'left',
              fontSize: '0.88rem',
              whiteSpace: 'nowrap',
              borderTop: '1px solid var(--border-color)',
            });

            return (
              <div className="flex-col gap-2">
                {/* Progress */}
                {comparisonsRunning && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--border-color)', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 2,
                        background: 'var(--accent-color)',
                        width: `${totalCount > 0 ? (completedCount / totalCount) * 100 : 0}%`,
                        transition: 'width 0.3s ease',
                      }} />
                    </div>
                    <span className="text-secondary" style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
                      {completedCount} / {totalCount} tariffs
                    </span>
                  </div>
                )}

                {/* Scrollable table */}
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                     <thead>
                       <tr>
                         <th style={thStyle('name')} onClick={() => handleSort('name')}>
                           Tariff <SortIndicator col="name" />
                         </th>
                         <th style={thStyle('cost')} onClick={() => handleSort('cost')}>
                           {isExportMeter ? 'Total Revenue' : 'Total Cost'} <SortIndicator col="cost" />
                         </th>
                         <th style={{ ...thStyle('cost'), cursor: 'default' }}>
                           Standing
                         </th>
                         <th style={thStyle('rate')} onClick={() => handleSort('rate')}>
                           Effective Rate <SortIndicator col="rate" />
                         </th>
                         {hasCurrentBaseline && (
                           <th style={thStyle('delta')} onClick={() => handleSort('delta')}>
                             vs Current <SortIndicator col="delta" />
                           </th>
                         )}
                       </tr>
                     </thead>
                     <tbody>
                       {/* Pinned: current tariff */}
                       {hasCurrentBaseline && (
                         <tr style={{ background: 'rgba(229,0,122,0.06)' }}>
                           <td style={{ ...cellStyle(), fontWeight: 600 }}>
                             {baseline.productFullName ?? baseline.tariffCode}
                             <span style={{ marginLeft: '0.5rem', fontSize: '0.68rem', padding: '0.1rem 0.4rem', borderRadius: '4px', background: 'var(--accent-color)', color: '#fff', verticalAlign: 'middle' }}>current</span>
                             <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 400, marginTop: '0.1rem' }}>{baseline.tariffCode}</span>
                           </td>
                           <td style={{ ...cellStyle(true), fontWeight: 600 }}>{penceToGBP(baseline.current.totalCostPence)}</td>
                           <td style={{ ...cellStyle(true), color: 'var(--text-secondary)' }}>{penceToGBP(baseline.current.standingChargePence)}</td>
                           <td style={cellStyle(true)}>{baseline.current.averagePencePerKwh.toFixed(2)}p/kWh</td>
                           {hasCurrentBaseline && <td style={{ ...cellStyle(true), color: 'var(--text-secondary)' }}>—</td>}
                         </tr>
                       )}

                       {/* Pinned: Ofgem cap — import only, no export price cap exists */}
                       {!isExportMeter && (
                         <tr style={{ background: 'var(--bg-color)' }}>
                           <td style={cellStyle()}>
                             Ofgem Price Cap
                             <span style={{ marginLeft: '0.5rem', fontSize: '0.68rem', padding: '0.1rem 0.4rem', borderRadius: '4px', background: 'var(--border-color)', color: 'var(--text-secondary)', verticalAlign: 'middle' }}>reference</span>
                           </td>
                           <td style={{ ...cellStyle(true), fontWeight: 600 }}>{penceToGBP(baseline.ofgem.totalCostPence)}</td>
                           <td style={{ ...cellStyle(true), color: 'var(--text-secondary)' }}>{penceToGBP(baseline.ofgem.standingChargePence)}</td>
                           <td style={cellStyle(true)}>{baseline.ofgem.averagePencePerKwh.toFixed(2)}p/kWh</td>
                           {hasCurrentBaseline && (() => {
                             const d = baseline.ofgem.totalCostPence - baseline.current.totalCostPence;
                             return <td style={{ ...cellStyle(true), color: d < 0 ? 'var(--success-color)' : d > 0 ? 'var(--error-color)' : 'var(--text-secondary)', fontWeight: 600 }}>
                               {d < 0 ? `Save ${penceToGBP(Math.abs(d))}` : d > 0 ? `+${penceToGBP(d)}` : 'Same'}
                             </td>;
                           })()}
                         </tr>
                       )}

                       {/* Divider */}
                       <tr><td colSpan={hasCurrentBaseline ? 5 : 4} style={{ padding: '0.25rem 0', borderTop: '2px solid var(--border-color)' }} /></tr>

                       {/* Available tariffs */}
                       {sorted.map((row, i) => {
                         const altResult = row.altResult;
                         const isEven = i % 2 === 0;
                         if (altResult === undefined) {
                           return (
                             <tr key={row.code} style={{ opacity: 0.4 }}>
                               <td style={cellStyle()}>{row.name}<span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{row.code}</span></td>
                               <td style={cellStyle(true)} colSpan={hasCurrentBaseline ? 4 : 3}>calculating…</td>
                             </tr>
                           );
                         }
                         if (altResult === null) {
                           return (
                             <tr key={row.code} style={{ opacity: 0.35 }}>
                               <td style={cellStyle()}>{row.name}<span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{row.code}</span></td>
                               <td style={{ ...cellStyle(true), fontSize: '0.78rem' }} colSpan={hasCurrentBaseline ? 4 : 3}>not available in your region</td>
                             </tr>
                           );
                         }
                         const { result, currentForSamePeriod } = altResult;
                         const isBest = row.code === bestProductCode;
                         const fullDays = baseline.current.periodDays || 1;
                         const coveredDays = result.periodDays || 1;
                         const isPartial = coveredDays < fullDays - 1;

                         // For partial tariffs: use the actual current-tariff cost over those same days.
                         // For full-period tariffs: compare against the full baseline as normal.
                         const baselinePence = hasCurrentBaseline
                           ? (isPartial && currentForSamePeriod !== null
                               ? currentForSamePeriod.totalCostPence
                               : baseline.current.totalCostPence)
                           : null;
                         const delta = baselinePence !== null
                           ? result.totalCostPence - baselinePence
                           : null;
                         const deltaColor = delta === null ? undefined
                           : isExportMeter
                             ? (delta > 0 ? 'var(--success-color)' : delta < 0 ? 'var(--error-color)' : 'var(--text-secondary)')
                             : (delta < 0 ? 'var(--success-color)' : delta > 0 ? 'var(--error-color)' : 'var(--text-secondary)');

                         return (
                           <tr key={row.code} style={{ background: isEven ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                             <td style={cellStyle()}>
                               {row.name}
                               {isBest && <span style={{ marginLeft: '0.5rem', fontSize: '0.68rem', padding: '0.1rem 0.4rem', borderRadius: '4px', background: 'var(--success-color)', color: '#000', verticalAlign: 'middle' }}>{isExportMeter ? 'best rate' : 'cheapest'}</span>}
                               <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{row.code}</span>
                               {isPartial && <span style={{ display: 'block', fontSize: '0.68rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>{coveredDays}d of data</span>}
                             </td>
                             <td style={{ ...cellStyle(true), fontWeight: 600 }}>
                               {penceToGBP(result.totalCostPence)}
                               {isPartial && <span style={{ fontSize: '0.68rem', fontWeight: 400, color: 'var(--text-secondary)' }}> /{coveredDays}d</span>}
                               {isPartial && currentForSamePeriod !== null && (
                                 <span style={{ display: 'block', fontSize: '0.68rem', fontWeight: 400, color: 'var(--text-secondary)' }}>
                                   vs {penceToGBP(currentForSamePeriod.totalCostPence)} current
                                 </span>
                               )}
                             </td>
                             <td style={{ ...cellStyle(true), color: 'var(--text-secondary)' }}>{penceToGBP(result.standingChargePence)}</td>
                             <td style={cellStyle(true)}>{result.averagePencePerKwh.toFixed(2)}p/kWh</td>
                             {hasCurrentBaseline && (
                               <td style={{ ...cellStyle(true), color: deltaColor, fontWeight: delta ? 600 : 400 }}>
                                 {delta === null ? '—'
                                  : isExportMeter
                                    ? (delta > 0 ? `+${penceToGBP(delta)} more` : delta < 0 ? `-${penceToGBP(Math.abs(delta))} less` : 'Same')
                                    : (delta < 0 ? `Save ${penceToGBP(Math.abs(delta))}` : delta > 0 ? `+${penceToGBP(delta)}` : 'Same')}
                               </td>
                             )}
                           </tr>
                         );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
