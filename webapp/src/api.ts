const BASE_URL = 'https://api.octopus.energy/v1';

export interface Meter {
  serial_number: string;
}

export interface MeterPoint {
  mpan?: string; // Electricity
  mprn?: string; // Gas
  meters: Meter[];
}

export interface Property {
  address_line_1: string;
  electricity_meter_points: MeterPoint[];
  gas_meter_points: MeterPoint[];
}

export interface OctopusAccount {
  number: string;
  properties: Property[];
}

export interface Product {
  code: string;
  full_name: string;
  display_name: string;
  description: string;
  is_variable: boolean;
  is_green: boolean;
  is_tracker: boolean;
  is_prepay: boolean;
  is_business: boolean;
}

export interface ConsumptionResult {
  consumption: number; // kWh
  interval_start: string;
  interval_end: string;
}

export interface ConsumptionResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: ConsumptionResult[];
}

export class OctopusApi {
  private apiKey: string;
  private accountNum: string;

  constructor(apiKey: string, accountNum: string) {
    this.apiKey = apiKey;
    this.accountNum = accountNum;
  }

  private get headers() {
    return {
      'Authorization': 'Basic ' + btoa(this.apiKey + ':'),
      'Content-Type': 'application/json',
    };
  }

  async getAccountDetails(): Promise<OctopusAccount> {
    const url = `${BASE_URL}/accounts/${this.accountNum}/`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) throw new Error(`Account fetch failed: ${res.status}`);
    return res.json();
  }

  async getProducts(): Promise<{ results: Product[] }> {
    const url = `${BASE_URL}/products/?is_available=true&is_business=false`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch tariffs.');
    return res.json();
  }

  // Generalized paginated fetcher
  async fetchAllPages<T>(url: string): Promise<T[]> {
    let results: T[] = [];
    let nextUrl: string | null = url;

    while (nextUrl) {
      // Must attach auth headers even to paginated URLs since they hit API endpoints requiring it (e.g., consumption)
      const isPublic = nextUrl.includes('/products/');
      const opts = isPublic ? undefined : { headers: this.headers };
      
      const res = await fetch(nextUrl, opts);
      if (!res.ok) throw new Error(`Failed to fetch from ${nextUrl}`);
      const data = await res.json();
      
      if (data.results) results = results.concat(data.results);
      nextUrl = data.next;
    }
    return results;
  }

  async getLatestConsumptionDate(fuelType: 'electricity' | 'gas', id: string, serial: string): Promise<string | null> {
    const ep = fuelType === 'electricity' ? `electricity-meter-points/${id}` : `gas-meter-points/${id}`;
    const url = `${BASE_URL}/${ep}/meters/${serial}/consumption/?page_size=1`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) return null;
    const data = await res.json() as ConsumptionResponse;
    return data.results?.[0]?.interval_end || null;
  }

  async getElectricityConsumption(mpan: string, serial: string, periodFrom: string, periodTo: string) {
    const url = `${BASE_URL}/electricity-meter-points/${mpan}/meters/${serial}/consumption/?period_from=${periodFrom}&period_to=${periodTo}&page_size=1500`;
    return this.fetchAllPages<ConsumptionResult>(url);
  }

  async getGasConsumption(mprn: string, serial: string, periodFrom: string, periodTo: string) {
    const url = `${BASE_URL}/gas-meter-points/${mprn}/meters/${serial}/consumption/?period_from=${periodFrom}&period_to=${periodTo}&page_size=1500`;
    return this.fetchAllPages<ConsumptionResult>(url);
  }
}
