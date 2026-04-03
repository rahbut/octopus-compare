import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  OctopusApi,
  toUtcIso,
  type OctopusAccount,
  type MeterPoint,
  type Product,
  type ConsumptionResult,
  type Agreement,
} from './api';
import {
  CostEngine,
  type CostCalculation,
  getGspFromMpan,
  calculateOfgemCapCost,
} from './CostEngine';
import {
  BarChart,
  Bar,
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
type AppView = 'usage' | 'compare';

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
  return sorted.find(ag => !ag.valid_to || new Date(ag.valid_to) > now) ?? sorted[0];
}

function productCodeFromTariffCode(tariffCode: string): string {
  // Pattern: {E|G}-{1R|2R}-{PRODUCT_CODE}-{REGION}
  const parts = tariffCode.split('-');
  if (parts.length >= 4) return parts.slice(2, -1).join('-');
  return tariffCode;
}


function penceToGBP(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

function aggregateByDay(consumption: ConsumptionResult[]) {
  const daily: Record<string, number> = {};
  for (const item of consumption) {
    const key = new Date(item.interval_start).toISOString().split('T')[0];
    daily[key] = (daily[key] ?? 0) + item.consumption;
  }
  return Object.keys(daily).sort().map(k => ({
    date: new Date(k).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
    dateKey: k,
    kWh: Number(daily[k].toFixed(3)),
  }));
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
      dateKey: k,
      kWh: Number(monthly[k].toFixed(3)),
    };
  });
}

/** Merge current + prior period into a single chart dataset for side-by-side bars */
function mergePeriodsForChart(
  current: ReturnType<typeof aggregateByDay>,
  prior: ReturnType<typeof aggregateByDay>,
  currentLabel: string,
  priorLabel: string
) {
  // Align by index position (day 1 vs day 1, day 2 vs day 2, etc.)
  const len = Math.max(current.length, prior.length);
  return Array.from({ length: len }, (_, i) => ({
    index: i + 1,
    [currentLabel]: current[i]?.kWh ?? null,
    [priorLabel]: prior[i]?.kWh ?? null,
    date: current[i]?.date ?? prior[i]?.date ?? '',
  }));
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
// Meter panel — shows one meter's usage + period comparison
// ---------------------------------------------------------------------------

const MeterPanel = React.memo(function MeterPanel({
  data, timeframe,
}: {
  data: MeterData;
  timeframe: Timeframe;
}) {
  const { meter, current, prior, currentCost, priorCost, loading, error } = data;
  const useMonthly = timeframe === '1year';

  const currentAgg = useMemo(
    () => useMonthly ? aggregateByMonth(current) : aggregateByDay(current),
    [current, useMonthly]
  );
  const priorAgg = useMemo(
    () => useMonthly ? aggregateByMonth(prior) : aggregateByDay(prior),
    [prior, useMonthly]
  );

  const chartData = useMemo(
    () => mergePeriodsForChart(currentAgg, priorAgg, 'current', 'prior'),
    [currentAgg, priorAgg]
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
        <div className="text-secondary text-center" style={{ padding: '2rem 0' }}>
          Loading…
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
                label="Avg Rate"
                value={`${currentCost.averagePencePerKwh.toFixed(1)}p/kWh`}
                sub="unit rate only"
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
              <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                <XAxis dataKey="date" stroke="var(--text-secondary)" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                <YAxis stroke="var(--text-secondary)" tick={{ fontSize: 11 }} unit=" kWh" width={60} />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  contentStyle={{ backgroundColor: 'var(--panel-bg)', borderColor: 'var(--border-color)', color: 'var(--text-primary)', borderRadius: '8px', fontSize: '0.85rem' }}
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
  const [meterData, setMeterData] = useState<Record<string, MeterData>>({});

  // Compare view state
  const [compareMeterId, setCompareMeterId] = useState<string>('');
  /** Baseline keyed by meter ID — computed for every meter, not just electricity */
  const [baselines, setBaselines] = useState<Record<string, BaselineResult>>({});
  /** productCode → calculated result (undefined = not yet done, null = failed) */
  const [altResults, setAltResults] = useState<Record<string, CostCalculation | null>>({});
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
        const [accData, prodData, name] = await Promise.all([
          api.getAccountDetails(),
          api.getProducts(),
          api.getViewerName(),
        ]);
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
          currentCost: null, priorCost: null, loading: true, error: null,
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

        const latestDate = new Date(latestStr);
        const days = timeframeDays(tf);
        const currentTo = latestDate;
        const currentFrom = new Date(currentTo.getTime() - days * 86400_000);
        const priorTo = currentFrom;
        const priorFrom = new Date(priorTo.getTime() - days * 86400_000);

        const [currentData, priorData] = await Promise.all([
          meter.fuelType === 'electricity'
            ? api.getElectricityConsumption(meter.id, meter.activeSerial, currentFrom.toISOString(), currentTo.toISOString())
            : api.getGasConsumption(meter.id, meter.activeSerial, currentFrom.toISOString(), currentTo.toISOString()),
          meter.fuelType === 'electricity'
            ? api.getElectricityConsumption(meter.id, meter.activeSerial, priorFrom.toISOString(), priorTo.toISOString())
            : api.getGasConsumption(meter.id, meter.activeSerial, priorFrom.toISOString(), priorTo.toISOString()),
        ]);

        // Compute costs using current tariff
        const agreement = getActiveAgreement(meter.point.agreements);
        let currentCost: CostCalculation | null = null;
        let priorCost: CostCalculation | null = null;

        if (agreement && currentData.length > 0) {
          const tariffCode = agreement.tariff_code;
          const productCode = productCodeFromTariffCode(tariffCode);
          const sortedCurrent = [...currentData].sort((a, b) => new Date(a.interval_start).getTime() - new Date(b.interval_start).getTime());
          const periodFrom = toUtcIso(sortedCurrent[0].interval_start);
          const periodTo = toUtcIso(sortedCurrent[sortedCurrent.length - 1].interval_end);

          try {
            const [unitRates, standingCharges] = await Promise.all([
              CostEngine.fetchTariffRates(api, productCode, tariffCode, meter.fuelType, periodFrom, periodTo),
              CostEngine.fetchStandingCharges(api, productCode, tariffCode, meter.fuelType, periodFrom, periodTo),
            ]);
            currentCost = CostEngine.calculateCost(currentData, unitRates, standingCharges);
          } catch {
            // Cost calculation failed — show usage data without cost
          }
        }

        if (agreement && priorData.length > 0) {
          // For the prior period, find the agreement that was active then
          const priorSortedData = [...priorData].sort((a, b) => new Date(a.interval_start).getTime() - new Date(b.interval_start).getTime());
          const priorPeriodFrom = toUtcIso(priorSortedData[0].interval_start);
          const priorPeriodTo = toUtcIso(priorSortedData[priorSortedData.length - 1].interval_end);

          // Find agreement active during the prior period
          const midPoint = new Date((new Date(priorPeriodFrom).getTime() + new Date(priorPeriodTo).getTime()) / 2);
          const priorAgreement = meter.point.agreements?.find(ag => {
            const from = new Date(ag.valid_from);
            const to = ag.valid_to ? new Date(ag.valid_to) : new Date('2099-01-01');
            return midPoint >= from && midPoint < to;
          }) ?? agreement;

          const priorProductCode = productCodeFromTariffCode(priorAgreement.tariff_code);

          try {
            const [priorUnitRates, priorStandingCharges] = await Promise.all([
              CostEngine.fetchTariffRates(api, priorProductCode, priorAgreement.tariff_code, meter.fuelType, priorPeriodFrom, priorPeriodTo),
              CostEngine.fetchStandingCharges(api, priorProductCode, priorAgreement.tariff_code, meter.fuelType, priorPeriodFrom, priorPeriodTo),
            ]);
            priorCost = CostEngine.calculateCost(priorData, priorUnitRates, priorStandingCharges);
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
                CostEngine.fetchTariffRates(api, productCode, tariffCode, meter.fuelType, periodFrom, periodTo),
                CostEngine.fetchStandingCharges(api, productCode, tariffCode, meter.fuelType, periodFrom, periodTo),
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
            latestDate, currentCost, priorCost, loading: false, error: null,
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

    // Accumulate all results locally; only the cheap counter triggers re-renders during the run.
    // A single setAltResults call at the end commits everything at once.
    const accumulated: Record<string, CostCalculation | null> = {};

    await Promise.all(compatibleProducts.map(async product => {
      // Export tariffs use E- prefix (they're electricity export unit rates)
      const tariffCode = meter.fuelType === 'gas'
        ? `G-1R-${product.code}-${regionChar}`
        : `E-1R-${product.code}-${regionChar}`;
      try {
        const [unitRates, standingCharges] = await Promise.all([
          CostEngine.fetchTariffRates(api, product.code, tariffCode, meter.fuelType, periodFrom, periodTo),
          CostEngine.fetchStandingCharges(api, product.code, tariffCode, meter.fuelType, periodFrom, periodTo),
        ]);
        accumulated[product.code] = CostEngine.calculateCost(consumption, unitRates, standingCharges);
      } catch {
        accumulated[product.code] = null;
      }
      // Only update the lightweight counter — keeps the progress bar alive without
      // re-rendering the full tree for every resolved tariff.
      setCompletedCount(c => c + 1);
    }));

    // Single state update — one re-render to show the completed table
    setAltResults(accumulated);
    setComparisonsRunning(false);
  }, [api, products, exportProducts]);

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
    if (bl?.productFullName) return { full: bl.productFullName, code: activeTariffCode };
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
  const activeProductList = useMemo(
    () => compareIsExport
      ? exportProducts
      : products.filter(p => compareFuelType === 'gas' ? p.has_gas : p.has_electricity),
    [compareIsExport, compareFuelType, products, exportProducts]
  );
  const sortedCompareRows = useMemo(() => {
    const rows = activeProductList.map(p => ({
      code: p.code,
      name: p.full_name,
      result: altResults[p.code] as CostCalculation | null | undefined,
    }));
    return rows.sort((a, b) => {
      const aR = a.result, bR = b.result;
      if (!aR && !bR) return 0;
      if (!aR) return 1;
      if (!bR) return -1;
      const baseline = baselines[compareMeterId];
      const hasBaseline = baseline?.tariffCode !== 'Unknown';
      let diff = 0;
      if (sortCol === 'name') diff = a.name.localeCompare(b.name);
      else if (sortCol === 'cost') diff = aR.totalCostPence - bR.totalCostPence;
      else if (sortCol === 'rate') diff = aR.averagePencePerKwh - bR.averagePencePerKwh;
      else if (sortCol === 'delta') {
        const base = hasBaseline ? baseline.current.totalCostPence : 0;
        diff = (aR.totalCostPence - base) - (bR.totalCostPence - base);
      }
      return sortAsc ? diff : -diff;
    });
  }, [activeProductList, altResults, sortCol, sortAsc, baselines, compareMeterId]);

  // O(N) single pass to find the best product code — used for the badge
  const bestProductCode = useMemo(() => {
    const resolved = sortedCompareRows.filter(r => r.result != null) as Array<{ code: string; name: string; result: CostCalculation }>;
    if (!resolved.length) return null;
    const baseline = baselines[compareMeterId];
    if (!baseline) return null;
    const best = compareIsExport
      ? resolved.reduce((a, b) => a.result.totalCostPence >= b.result.totalCostPence ? a : b)
      : resolved.reduce((a, b) => a.result.totalCostPence <= b.result.totalCostPence ? a : b);
    // Only badge it if it actually beats the current tariff
    const delta = best.result.totalCostPence - baseline.current.totalCostPence;
    if (compareIsExport && delta <= 0) return null;
    if (!compareIsExport && delta >= 0) return null;
    return best.code;
  }, [sortedCompareRows, baselines, compareMeterId, compareIsExport]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (loading) {
    return <div className="panel text-center text-secondary">Connecting to your account…</div>;
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
              onClick={() => setTimeframe(tf)}
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
                           Avg Unit Rate <SortIndicator col="rate" />
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
                         const result = row.result;
                         const isEven = i % 2 === 0;
                         if (result === undefined) {
                           return (
                             <tr key={row.code} style={{ opacity: 0.4 }}>
                               <td style={cellStyle()}>{row.name}<span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{row.code}</span></td>
                               <td style={cellStyle(true)} colSpan={hasCurrentBaseline ? 4 : 3}>calculating…</td>
                             </tr>
                           );
                         }
                         if (result === null) {
                           return (
                             <tr key={row.code} style={{ opacity: 0.35 }}>
                               <td style={cellStyle()}>{row.name}<span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{row.code}</span></td>
                               <td style={{ ...cellStyle(true), fontSize: '0.78rem' }} colSpan={hasCurrentBaseline ? 4 : 3}>not available in your region</td>
                             </tr>
                           );
                         }
                         const delta = hasCurrentBaseline ? result.totalCostPence - baseline.current.totalCostPence : null;
                         // Export: higher payout = good (green); import: lower cost = good (green)
                         const deltaColor = delta === null ? undefined
                           : isExportMeter
                             ? (delta > 0 ? 'var(--success-color)' : delta < 0 ? 'var(--error-color)' : 'var(--text-secondary)')
                             : (delta < 0 ? 'var(--success-color)' : delta > 0 ? 'var(--error-color)' : 'var(--text-secondary)');
                          const isBest = row.code === bestProductCode;

                        return (
                          <tr key={row.code} style={{ background: isEven ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                            <td style={cellStyle()}>
                              {row.name}
                              {isBest && <span style={{ marginLeft: '0.5rem', fontSize: '0.68rem', padding: '0.1rem 0.4rem', borderRadius: '4px', background: 'var(--success-color)', color: '#000', verticalAlign: 'middle' }}>{isExportMeter ? 'best rate' : 'cheapest'}</span>}
                              <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{row.code}</span>
                            </td>
                            <td style={{ ...cellStyle(true), fontWeight: 600 }}>{penceToGBP(result.totalCostPence)}</td>
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
