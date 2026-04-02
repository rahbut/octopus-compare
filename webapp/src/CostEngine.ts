import { type ConsumptionResult, OctopusApi } from './api';

export interface Rate {
  valid_from: string;
  valid_to: string | null;
  value_inc_vat: number;
}

export interface CostCalculation {
  totalCostPence: number;
  totalConsumptionKwh: number;
  averagePencePerKwh: number;
}

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
    const url = `https://api.octopus.energy/v1/products/${productCode}/${endpoint}/${tariffCode}/standard-unit-rates/?page_size=1500&period_from=${periodFrom}&period_to=${periodTo}`;
    
    // Fetch all applicable rates
    const rates = await api.fetchAllPages<{ valid_from: string; valid_to: string; value_inc_vat: number }>(url);
    return rates;
  }

  static calculateCost(consumption: ConsumptionResult[], rates: Rate[]): CostCalculation {
    let totalCostPence = 0;
    let totalConsumptionKwh = 0;

    // A simple O(N*M) calculation since N (consumption) is < 1500 and M (rates) is < 1500 typically per month.
    // Can be optimized by sorting and stepping through, but acceptable for MVP.
    for (const slot of consumption) {
      const slotStart = new Date(slot.interval_start).getTime();

      // Find the rate that applies to this slot
      const applicableRate = rates.find(r => {
        const rateStart = r.valid_from ? new Date(r.valid_from).getTime() : 0;
        const rateEnd = r.valid_to ? new Date(r.valid_to).getTime() : Infinity;
        // The slot should fall within the rate's validity period
        return slotStart >= rateStart && slotStart < rateEnd;
      });

      // If we don't find a half-hourly rate, there might be a fallback or default rate (for non-agile tariffs)
      // Usually, fixed tariffs have a single rate covering years.
      const rateToApply = applicableRate ? applicableRate.value_inc_vat : (rates[0]?.value_inc_vat || 0);

      totalCostPence += slot.consumption * rateToApply;
      totalConsumptionKwh += slot.consumption;
    }

    return {
      totalCostPence,
      totalConsumptionKwh,
      averagePencePerKwh: totalConsumptionKwh > 0 ? (totalCostPence / totalConsumptionKwh) : 0
    };
  }
}
