import { useState, useEffect, useMemo, useCallback } from 'react';
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
      <span style={{ fontSize: '1.4rem', fontWeight: 700, lineHeight: 1.15 }}>{value}</span>
      {delta && (
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

function ComparisonRow({
  label, result, baseline, isCurrent, isOfgem,
}: {
  label: string; result: CostCalculation; baseline?: CostCalculation;
  isCurrent?: boolean; isOfgem?: boolean;
}) {
  const delta = baseline ? result.totalCostPence - baseline.totalCostPence : null;
  const deltaStr = delta === null ? null
    : delta < 0 ? `Save ${penceToGBP(Math.abs(delta))}`
    : delta > 0 ? `+${penceToGBP(delta)} extra`
    : 'Same cost';
  const deltaColor = delta === null ? undefined
    : delta < 0 ? 'var(--success-color)'
    : delta > 0 ? 'var(--error-color)'
    : 'var(--text-secondary)';

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr repeat(4, auto)',
      gap: '1rem', alignItems: 'center',
      padding: '0.75rem 1rem', borderRadius: '8px',
      background: isCurrent ? 'rgba(229,0,122,0.06)' : 'var(--bg-color)',
      border: isCurrent ? '1px solid var(--accent-color)' : '1px solid var(--border-color)',
      fontSize: '0.9rem',
    }}>
      <span style={{ fontWeight: isCurrent ? 700 : 400 }}>
        {label}
        {isCurrent && <span style={{ marginLeft: '0.5rem', fontSize: '0.7rem', padding: '0.1rem 0.4rem', borderRadius: '4px', background: 'var(--accent-color)', color: '#fff', verticalAlign: 'middle' }}>current</span>}
        {isOfgem && <span style={{ marginLeft: '0.5rem', fontSize: '0.7rem', padding: '0.1rem 0.4rem', borderRadius: '4px', background: 'var(--border-color)', color: 'var(--text-secondary)', verticalAlign: 'middle' }}>Ofgem cap</span>}
      </span>
      <span style={{ textAlign: 'right', minWidth: 70 }}>{result.totalConsumptionKwh.toFixed(1)} kWh</span>
      <span style={{ textAlign: 'right', minWidth: 80, fontWeight: 600 }}>{penceToGBP(result.totalCostPence)}</span>
      <span className="text-secondary" style={{ textAlign: 'right', minWidth: 80, fontSize: '0.82rem' }}>{result.averagePencePerKwh.toFixed(1)}p/kWh</span>
      <span style={{ textAlign: 'right', minWidth: 90, color: deltaColor, fontWeight: delta ? 600 : 400 }}>{deltaStr ?? '—'}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meter panel — shows one meter's usage + period comparison
// ---------------------------------------------------------------------------

function MeterPanel({
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

  const currentKwh = current.reduce((s, r) => s + r.consumption, 0);
  const priorKwh = prior.reduce((s, r) => s + r.consumption, 0);
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
                label="Cost"
                value={penceToGBP(currentCost.totalCostPence)}
                sub={`inc. ${penceToGBP(currentCost.standingChargePence)} standing`}
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
                label="vs Prior Period"
                value={`${kwhDelta >= 0 ? '+' : ''}${kwhDelta.toFixed(1)} kWh`}
                sub={`${kwhDeltaPct !== null ? `${kwhDeltaPct >= 0 ? '+' : ''}${kwhDeltaPct.toFixed(0)}%` : ''} ${priorPeriodLabel(timeframe)}`}
                delta={{
                  value: costDelta !== null
                    ? `${costDelta >= 0 ? '+' : ''}${penceToGBP(costDelta)} cost`
                    : '',
                  positive: kwhDelta !== null ? kwhDelta < 0 : null,
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
}

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------

export function Dashboard({ api }: DashboardProps) {
  const [account, setAccount] = useState<OctopusAccount | null>(null);
  const [meters, setMeters] = useState<MeterInfo[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);

  const [appView, setAppView] = useState<AppView>('usage');
  const [timeframe, setTimeframe] = useState<Timeframe>('30days');
  const [meterData, setMeterData] = useState<Record<string, MeterData>>({});

  // Compare view state
  const [compareMeterId, setCompareMeterId] = useState<string>('');
  const [selectedProduct, setSelectedProduct] = useState<string>('');
  const [isCalculatingAlt, setIsCalculatingAlt] = useState(false);
  const [altResult, setAltResult] = useState<CostCalculation | null>(null);
  const [altProductName, setAltProductName] = useState<string>('');
  const [baseline, setBaseline] = useState<BaselineResult | null>(null);

  // -----------------------------------------------------------------------
  // Load account + products + resolve active serials
  // -----------------------------------------------------------------------

  useEffect(() => {
    async function init() {
      try {
        setLoading(true);
        const [accData, prodData] = await Promise.all([
          api.getAccountDetails(),
          api.getProducts(),
        ]);

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

        const domestic = prodData.results.filter(p => !p.is_business);
        setProducts(domestic);
        if (domestic.length > 0) {
          setSelectedProduct(domestic[0].code);
          setAltProductName(domestic[0].display_name);
        }
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

        // Also compute Ofgem cap for the compare view baseline (electricity import only)
        if (!meter.isExport && meter.fuelType === 'electricity' && currentData.length > 0) {
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
              const ofgem = calculateOfgemCapCost(currentData, regionLetter, meter.fuelType);
              setBaseline({ current, ofgem, tariffCode, productCode, regionLetter });
            } catch {
              // baseline unavailable
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
    setAltResult(null);
    setBaseline(null);
    fetchAllMeters(meters, timeframe, account);
  }, [meters, timeframe, account, fetchAllMeters]);

  // -----------------------------------------------------------------------
  // Compare view: run alternative tariff
  // -----------------------------------------------------------------------

  const runComparison = async () => {
    const meter = meters.find(m => m.id === compareMeterId);
    const mData = meterData[compareMeterId];
    if (!meter || !mData?.current.length) return;

    setIsCalculatingAlt(true);
    setAltResult(null);

    try {
      const sorted = [...mData.current].sort(
        (a, b) => new Date(a.interval_start).getTime() - new Date(b.interval_start).getTime()
      );
      const periodFrom = toUtcIso(sorted[0].interval_start);
      const periodTo = toUtcIso(sorted[sorted.length - 1].interval_end);

      const regionLetter = baseline?.regionLetter ?? '_A';
      const regionChar = regionLetter.replace('_', '');
      const tariffCode = meter.fuelType === 'gas'
        ? `G-1R-${selectedProduct}-${regionChar}`
        : `E-1R-${selectedProduct}-${regionChar}`;

      const [unitRates, standingCharges] = await Promise.all([
        CostEngine.fetchTariffRates(api, selectedProduct, tariffCode, meter.fuelType, periodFrom, periodTo),
        CostEngine.fetchStandingCharges(api, selectedProduct, tariffCode, meter.fuelType, periodFrom, periodTo),
      ]);

      const result = CostEngine.calculateCost(mData.current, unitRates, standingCharges);
      setAltResult(result);

      const product = products.find(p => p.code === selectedProduct);
      setAltProductName(product?.display_name ?? selectedProduct);
    } catch (err: unknown) {
      alert('Error modelling cost: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsCalculatingAlt(false);
    }
  };

  // -----------------------------------------------------------------------
  // Derived
  // -----------------------------------------------------------------------

  const property = account?.properties[0];
  const importElec = meters.find(m => m.fuelType === 'electricity' && !m.isExport);
  const activeAgreementLabel = useMemo(
    () => getActiveAgreement(importElec?.point.agreements)?.tariff_code ?? null,
    [importElec]
  );

  const anyLoading = Object.values(meterData).some(d => d.loading);

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
          <h2 style={{ margin: 0 }}>Account {account.number}</h2>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '0.2rem' }}>
            {property?.address_line_1 && (
              <span className="text-secondary" style={{ fontSize: '0.85rem' }}>
                {[property.address_line_1, property.address_line_3, property.town].filter(Boolean).join(', ')}
              </span>
            )}
            {activeAgreementLabel && (
              <span className="text-secondary" style={{ fontSize: '0.85rem' }}>
                Tariff: <strong style={{ color: 'var(--text-primary)' }}>{activeAgreementLabel}</strong>
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

      {/* ------------------------------------------------------------------ */}
      {/* USAGE VIEW                                                          */}
      {/* ------------------------------------------------------------------ */}
      {appView === 'usage' && (
        <>
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
          <div>
            <h2 style={{ margin: '0 0 0.25rem 0' }}>Tariff Comparison</h2>
            <p className="text-secondary" style={{ margin: 0, fontSize: '0.87rem' }}>
              What would your consumption have cost on a different tariff? Uses the same data already loaded.
            </p>
          </div>

          {/* Meter + product selectors */}
          <div className="flex-col gap-2">
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <div className="flex-col gap-1" style={{ flex: '0 0 auto' }}>
                <label className="text-secondary" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Meter</label>
                <select
                  value={compareMeterId}
                  onChange={e => { setCompareMeterId(e.target.value); setAltResult(null); setBaseline(null); }}
                  style={{ padding: '0.6rem', borderRadius: '6px', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
                >
                  {meters.map(m => (
                    <option key={m.id} value={m.id}>{m.label}: {m.id}</option>
                  ))}
                </select>
              </div>
              <div className="flex-col gap-1" style={{ flex: 1, minWidth: 200 }}>
                <label className="text-secondary" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Compare against</label>
                <select
                  value={selectedProduct}
                  onChange={e => { setSelectedProduct(e.target.value); setAltResult(null); }}
                  style={{ padding: '0.6rem', borderRadius: '6px', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', width: '100%' }}
                >
                  {products.map(p => (
                    <option key={p.code} value={p.code}>{p.display_name} ({p.code})</option>
                  ))}
                </select>
              </div>
              <div className="flex-col gap-1" style={{ justifyContent: 'flex-end', paddingBottom: '0' }}>
                <label style={{ fontSize: '0.8rem', visibility: 'hidden' }}>Run</label>
                <button
                  onClick={runComparison}
                  disabled={isCalculatingAlt || !meterData[compareMeterId]?.current.length}
                >
                  {isCalculatingAlt ? 'Modelling…' : 'Model Costs →'}
                </button>
              </div>
            </div>
          </div>

          {/* Comparison table */}
          {baseline && (
            <div className="flex-col gap-2">
              <div className="text-secondary" style={{
                display: 'grid', gridTemplateColumns: '1fr repeat(4, auto)',
                gap: '1rem', padding: '0 1rem',
                fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                <span>Tariff</span>
                <span style={{ textAlign: 'right', minWidth: 70 }}>kWh</span>
                <span style={{ textAlign: 'right', minWidth: 80 }}>Total Cost</span>
                <span style={{ textAlign: 'right', minWidth: 80 }}>Avg Rate</span>
                <span style={{ textAlign: 'right', minWidth: 90 }}>vs Current</span>
              </div>

              <ComparisonRow
                label={baseline.tariffCode}
                result={baseline.current}
                isCurrent={baseline.tariffCode !== 'Unknown'}
              />
              <ComparisonRow
                label="Ofgem Price Cap"
                result={baseline.ofgem}
                baseline={baseline.tariffCode !== 'Unknown' ? baseline.current : undefined}
                isOfgem
              />
              {altResult && (
                <ComparisonRow
                  label={altProductName}
                  result={altResult}
                  baseline={baseline.tariffCode !== 'Unknown' ? baseline.current : undefined}
                />
              )}
            </div>
          )}

          {!baseline && meterData[compareMeterId]?.current.length === 0 && !anyLoading && (
            <p className="text-secondary" style={{ fontSize: '0.87rem' }}>
              No consumption data loaded for this meter. Switch to Usage view and ensure data is available.
            </p>
          )}

          {!baseline && meterData[compareMeterId]?.current.length > 0 && !anyLoading && (
            <p className="text-secondary" style={{ fontSize: '0.87rem' }}>
              Current tariff baseline is still loading…
            </p>
          )}
        </div>
      )}
    </div>
  );
}
