import { type ConsumptionResult, OctopusApi, toUtcIso } from './api';
import ofgemData from './data/ofgem-price-cap.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Rate {
  valid_from: string;
  valid_to: string | null;
  value_inc_vat: number;
}

export interface CostCalculation {
  /** Unit-rate cost only, in pence */
  unitCostPence: number;
  /** Standing charge total for the period, in pence */
  standingChargePence: number;
  /** Combined total (unit + standing), in pence */
  totalCostPence: number;
  totalConsumptionKwh: number;
  averagePencePerKwh: number;
  /** Number of days the period spans (for standing charge calculation) */
  periodDays: number;
}

// ---------------------------------------------------------------------------
// GSP region derivation from MPAN
//
// The MPAN is a 13-digit number. The first two digits identify the
// Distribution Network Operator (DNO), which maps to a GSP region letter
// used in Octopus tariff codes (e.g. _A, _B … _P, skipping _I and _O).
//
// Source: Ofgem DNO/GSP mapping (publicly documented).
// ---------------------------------------------------------------------------

const DNO_TO_GSP: Record<string, string> = {
  '10': '_A', // Eastern England
  '11': '_B', // East Midlands
  '12': '_C', // London
  '13': '_D', // Merseyside and North Wales
  '14': '_E', // West Midlands
  '15': '_F', // North East England
  '16': '_G', // North West England
  '17': '_H', // Southern England
  '18': '_J', // South East England
  '19': '_K', // South Western England
  '20': '_L', // South Wales
  '21': '_M', // Yorkshire
  '22': '_N', // South Scotland
  '23': '_P', // North Scotland
};

/**
 * Derive the GSP region letter suffix (e.g. "_C") from a 13-digit MPAN.
 * Falls back to "_A" (Eastern England) if the MPAN is unrecognised.
 */
export function getGspFromMpan(mpan: string): string {
  const digits = mpan.replace(/\s+/g, '');
  const dno = digits.substring(0, 2);
  return DNO_TO_GSP[dno] ?? '_A';
}

/**
 * Given a tariff code like "E-1R-AGILE-FLEX-22-11-25-A" or a partial product
 * code, extract the region letter suffix (last character before any trailing
 * segment). If the code already ends in a known region letter, return it.
 * Returns null if not found.
 */
export function getRegionFromTariffCode(tariffCode: string): string | null {
  // Tariff codes end with a single region letter: e.g. …-G or …-A
  const match = tariffCode.match(/-([A-PR])$/i);
  if (match) return `_${match[1].toUpperCase()}`;
  return null;
}

// ---------------------------------------------------------------------------
// Ofgem Price Cap helpers
// ---------------------------------------------------------------------------

interface OfgemQuarter {
  period_from: string;
  period_to: string;
  label: string;
  regions: Record<string, {
    electricity: { unit_rate_inc_vat: number; standing_charge_inc_vat: number };
    gas: { unit_rate_inc_vat: number; standing_charge_inc_vat: number };
  }>;
}

const ofgemQuarters = (ofgemData as { quarters: OfgemQuarter[] }).quarters;

/**
 * Return all Ofgem quarterly cap entries that overlap the given date range,
 * each annotated with the capped rates for the requested region and fuel type.
 */
function getOfgemRatesForPeriod(
  region: string,
  fuelType: 'electricity' | 'gas',
  periodFrom: string,
  periodTo: string
): Array<{ from: Date; to: Date; unitRate: number; standingCharge: number }> {
  const from = new Date(periodFrom);
  const to = new Date(periodTo);

  const segments: Array<{ from: Date; to: Date; unitRate: number; standingCharge: number }> = [];

  for (const q of ofgemQuarters) {
    const qFrom = new Date(q.period_from);
    // period_to in the JSON is the last day of the quarter, so add 1 day to
    // make it an exclusive end date
    const qTo = new Date(q.period_to);
    qTo.setDate(qTo.getDate() + 1);

    // Skip quarters that don't overlap
    if (qTo <= from || qFrom >= to) continue;

    const regionData = q.regions[region] ?? q.regions['_A'];
    const fuelData = regionData?.[fuelType];
    if (!fuelData) continue;

    segments.push({
      from: qFrom < from ? from : qFrom,
      to: qTo > to ? to : qTo,
      unitRate: fuelData.unit_rate_inc_vat,
      standingCharge: fuelData.standing_charge_inc_vat,
    });
  }

  return segments;
}

/**
 * Calculate the cost under the Ofgem price cap for a given set of consumption
 * slots, region, and fuel type.
 */
export function calculateOfgemCapCost(
  consumption: ConsumptionResult[],
  region: string,
  fuelType: 'electricity' | 'gas'
): CostCalculation {
  if (!consumption.length) {
    return { unitCostPence: 0, standingChargePence: 0, totalCostPence: 0, totalConsumptionKwh: 0, averagePencePerKwh: 0, periodDays: 0 };
  }

  const sorted = [...consumption].sort(
    (a, b) => new Date(a.interval_start).getTime() - new Date(b.interval_start).getTime()
  );
  const periodFrom = sorted[0].interval_start;
  const periodTo = sorted[sorted.length - 1].interval_end;

  const segments = getOfgemRatesForPeriod(region, fuelType, periodFrom, periodTo);

  let unitCostPence = 0;
  let totalConsumptionKwh = 0;

  for (const slot of consumption) {
    const slotStart = new Date(slot.interval_start).getTime();

    // Find which quarterly segment this slot falls in
    const seg = segments.find(s => slotStart >= s.from.getTime() && slotStart < s.to.getTime());
    const rate = seg?.unitRate ?? segments[0]?.unitRate ?? 0;

    unitCostPence += slot.consumption * rate;
    totalConsumptionKwh += slot.consumption;
  }

  const periodDays = Math.max(
    1,
    Math.round((new Date(periodTo).getTime() - new Date(periodFrom).getTime()) / (1000 * 60 * 60 * 24))
  );

  // Standing charge: use the weighted average across overlapping quarters
  let standingChargePence = 0;
  for (const seg of segments) {
    const segDays = Math.max(
      0,
      Math.round((seg.to.getTime() - seg.from.getTime()) / (1000 * 60 * 60 * 24))
    );
    standingChargePence += segDays * seg.standingCharge;
  }

  const totalCostPence = unitCostPence + standingChargePence;

  return {
    unitCostPence,
    standingChargePence,
    totalCostPence,
    totalConsumptionKwh,
    averagePencePerKwh: totalConsumptionKwh > 0 ? unitCostPence / totalConsumptionKwh : 0,
    periodDays,
  };
}

// ---------------------------------------------------------------------------
// CostEngine class
// ---------------------------------------------------------------------------

export class CostEngine {

  static async fetchTariffRates(
    api: OctopusApi,
    productCode: string,
    tariffCode: string,
    fuelType: 'electricity' | 'gas',
    periodFrom: string,
    periodTo: string
  ): Promise<Rate[]> {
    const endpoint = fuelType === 'electricity' ? 'electricity-tariffs' : 'gas-tariffs';
    const url = `https://api.octopus.energy/v1/products/${productCode}/${endpoint}/${tariffCode}/standard-unit-rates/?page_size=1500&period_from=${toUtcIso(periodFrom)}&period_to=${toUtcIso(periodTo)}`;
    const rates = await api.fetchAllPages<{ valid_from: string; valid_to: string; value_inc_vat: number }>(url);
    return rates;
  }

  static async fetchStandingCharges(
    api: OctopusApi,
    productCode: string,
    tariffCode: string,
    fuelType: 'electricity' | 'gas',
    periodFrom: string,
    periodTo: string
  ): Promise<Rate[]> {
    const endpoint = fuelType === 'electricity' ? 'electricity-tariffs' : 'gas-tariffs';
    const url = `https://api.octopus.energy/v1/products/${productCode}/${endpoint}/${tariffCode}/standing-charges/?page_size=1500&period_from=${toUtcIso(periodFrom)}&period_to=${toUtcIso(periodTo)}`;
    const rates = await api.fetchAllPages<{ valid_from: string; valid_to: string; value_inc_vat: number }>(url);
    return rates;
  }

  /**
   * Calculate the total cost for a set of consumption slots against a set of
   * unit rates, with optional standing charge rates.
   *
   * Standing charges are in p/day; the number of days is derived from the
   * consumption period.
   */
  static calculateCost(
    consumption: ConsumptionResult[],
    unitRates: Rate[],
    standingChargeRates: Rate[] = []
  ): CostCalculation {
    if (!consumption.length) {
      return { unitCostPence: 0, standingChargePence: 0, totalCostPence: 0, totalConsumptionKwh: 0, averagePencePerKwh: 0, periodDays: 0 };
    }

    const sorted = [...consumption].sort(
      (a, b) => new Date(a.interval_start).getTime() - new Date(b.interval_start).getTime()
    );
    const periodFrom = new Date(sorted[0].interval_start);
    const periodTo = new Date(sorted[sorted.length - 1].interval_end);
    const periodDays = Math.max(
      1,
      Math.round((periodTo.getTime() - periodFrom.getTime()) / (1000 * 60 * 60 * 24))
    );

    let unitCostPence = 0;
    let totalConsumptionKwh = 0;

    for (const slot of consumption) {
      const slotStart = new Date(slot.interval_start).getTime();

      const applicableRate = unitRates.find(r => {
        const rateStart = r.valid_from ? new Date(r.valid_from).getTime() : 0;
        const rateEnd = r.valid_to ? new Date(r.valid_to).getTime() : Infinity;
        return slotStart >= rateStart && slotStart < rateEnd;
      });

      // For fixed/variable tariffs a single rate covers the whole period;
      // fall back to the first entry if no exact match found.
      const rateToApply = applicableRate?.value_inc_vat ?? unitRates[0]?.value_inc_vat ?? 0;

      unitCostPence += slot.consumption * rateToApply;
      totalConsumptionKwh += slot.consumption;
    }

    // Standing charges: accumulate p/day for each day in the period
    let standingChargePence = 0;
    if (standingChargeRates.length > 0) {
      // Walk day-by-day over the period
      const cursor = new Date(periodFrom);
      while (cursor < periodTo) {
        const dayTs = cursor.getTime();
        const sc = standingChargeRates.find(r => {
          const rateStart = r.valid_from ? new Date(r.valid_from).getTime() : 0;
          const rateEnd = r.valid_to ? new Date(r.valid_to).getTime() : Infinity;
          return dayTs >= rateStart && dayTs < rateEnd;
        });
        const scRate = sc?.value_inc_vat ?? standingChargeRates[0]?.value_inc_vat ?? 0;
        standingChargePence += scRate;
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    const totalCostPence = unitCostPence + standingChargePence;

    return {
      unitCostPence,
      standingChargePence,
      totalCostPence,
      totalConsumptionKwh,
      averagePencePerKwh: totalConsumptionKwh > 0 ? unitCostPence / totalConsumptionKwh : 0,
      periodDays,
    };
  }
}
