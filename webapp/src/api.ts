const BASE_URL = 'https://api.octopus.energy/v1';

/**
 * Convert any date string or Date to a UTC ISO-8601 string (ending in Z).
 * The Octopus API rejects period parameters with timezone offsets (+01:00 etc).
 */
export function toUtcIso(date: string | Date): string {
  return new Date(date).toISOString();
}

export interface MeterRegister {
  identifier: string;
  rate: string;
  is_settlement_register: boolean;
}

export interface Meter {
  serial_number: string;
  registers?: MeterRegister[];
}

export interface Agreement {
  tariff_code: string;
  valid_from: string;
  valid_to: string | null;
}

export interface MeterPoint {
  mpan?: string; // Electricity
  mprn?: string; // Gas
  meters: Meter[];
  agreements?: Agreement[];
  is_export?: boolean; // true for solar/generation export MPANs
}

export interface Property {
  address_line_1: string;
  address_line_2?: string;
  address_line_3?: string;
  town?: string;
  county?: string;
  postcode?: string;
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
  /** Populated after fetching product detail — undefined means not yet checked */
  has_electricity?: boolean;
  has_gas?: boolean;
}

export interface ConsumptionResult {
  consumption: number; // kWh (or m³ for SMETS1 gas)
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

  /** Fetch the customer's given name via the GraphQL API. Returns null on failure. */
  async getViewerName(): Promise<string | null> {
    const GQL = 'https://api.octopus.energy/v1/graphql/';
    const post = (body: object, token?: string) => fetch(GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `JWT ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

    try {
      // Step 1 — exchange the API key for a short-lived JWT
      const tokenRes = await post({
        query: `mutation { obtainKrakenToken(input: { APIKey: "${this.apiKey}" }) { token } }`,
      });
      if (!tokenRes.ok) {
        console.warn(`[Octopus] GraphQL token exchange failed: HTTP ${tokenRes.status}`);
        return null;
      }
      const tokenData = await tokenRes.json();
      const token: string | undefined = tokenData?.data?.obtainKrakenToken?.token;
      if (!token) {
        const errs = tokenData?.errors?.map((e: { message: string }) => e.message).join(', ');
        console.warn('[Octopus] GraphQL token exchange returned no token:', errs ?? 'unknown error');
        return null;
      }

      // Step 2 — query the viewer's given name
      const nameRes = await post({ query: '{ viewer { givenName } }' }, token);
      if (!nameRes.ok) {
        console.warn(`[Octopus] GraphQL name query failed: HTTP ${nameRes.status}`);
        return null;
      }
      const nameData = await nameRes.json();
      const name: string | null = nameData?.data?.viewer?.givenName ?? null;
      const nameErrors = nameData?.errors;
      if (nameErrors?.length) {
        console.warn('[Octopus] GraphQL name query errors:', nameErrors.map((e: { message: string }) => e.message).join(', '));
      }
      if (!name) console.warn('[Octopus] GraphQL returned no givenName');
      return name;
    } catch (err) {
      console.warn('[Octopus] GraphQL name fetch threw:', err);
      return null;
    }
  }

  async getAccountDetails(): Promise<OctopusAccount> {
    const url = `${BASE_URL}/accounts/${this.accountNum}/`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) throw new Error(`Account fetch failed: ${res.status}`);
    return res.json();
  }

  /** Fetch a single product's detail (no auth required). Returns null on failure. */
  async getProductDetail(productCode: string): Promise<{
    full_name: string;
    display_name: string;
    has_electricity: boolean;
    has_gas: boolean;
  } | null> {
    try {
      const res = await fetch(`${BASE_URL}/products/${productCode}/`);
      if (!res.ok) return null;
      const data = await res.json();
      return {
        full_name: data.full_name,
        display_name: data.display_name,
        has_electricity: Object.keys(data.single_register_electricity_tariffs ?? {}).length > 0,
        has_gas: Object.keys(data.single_register_gas_tariffs ?? {}).length > 0,
      };
    } catch {
      return null;
    }
  }

  /** Fetches all available domestic products across all pages. */
  async getProducts(): Promise<{ results: Product[] }> {
    const url = `${BASE_URL}/products/?is_available=true&is_business=false&page_size=100`;
    const results = await this.fetchAllPages<Product>(url);
    return { results };
  }

  // Generalised paginated fetcher
  async fetchAllPages<T>(url: string): Promise<T[]> {
    let results: T[] = [];
    let nextUrl: string | null = url;

    while (nextUrl) {
      // Attach auth headers for authenticated endpoints; products endpoint is public
      const isPublic = nextUrl.includes('/products/');
      const opts = isPublic ? undefined : { headers: this.headers };

      const res = await fetch(nextUrl, opts);
      if (res.status === 429) throw new Error('Octopus API rate limit reached — please wait a moment and try again');
      if (!res.ok) throw new Error(`Failed to fetch from ${nextUrl} (${res.status})`);
      const data = await res.json();

      if (data.results) results = results.concat(data.results);
      nextUrl = data.next;
    }
    return results;
  }

  /**
   * Find the active serial number for a meter point by trying each listed serial
   * in order of preference (settlement register with a named rate first) and
   * returning the first one that actually has consumption data.
   */
  async findActiveSerial(
    fuelType: 'electricity' | 'gas',
    id: string,
    serials: string[]
  ): Promise<string | null> {
    for (const serial of serials) {
      const ep = fuelType === 'electricity' ? `electricity-meter-points/${id}` : `gas-meter-points/${id}`;
      const url = `${BASE_URL}/${ep}/meters/${serial}/consumption/?page_size=1`;
      const res = await fetch(url, { headers: this.headers });
      if (!res.ok) continue;
      const data = await res.json() as ConsumptionResponse;
      if (data.results?.length) return serial;
    }
    return null;
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

  /**
   * Fetch daily unit rates for a Tracker (or any) tariff over a given period.
   * Returns rates newest-first as the API provides them.
   */
  async fetchUnitRates(
    productCode: string,
    tariffCode: string,
    fuelType: 'electricity' | 'gas',
    periodFrom?: string,
    periodTo?: string,
  ): Promise<{ value_inc_vat: number; valid_from: string; valid_to: string | null; payment_method: string | null }[]> {
    const endpoint = fuelType === 'electricity' ? 'electricity-tariffs' : 'gas-tariffs';
    let url = `${BASE_URL}/products/${productCode}/${endpoint}/${tariffCode}/standard-unit-rates/?page_size=1500`;
    if (periodFrom) url += `&period_from=${toUtcIso(periodFrom)}`;
    if (periodTo) url += `&period_to=${toUtcIso(periodTo)}`;
    const rates = await this.fetchAllPages<{ value_inc_vat: number; valid_from: string; valid_to: string | null; payment_method: string | null }>(url);
    return rates.filter(r => !r.payment_method || r.payment_method === 'DIRECT_DEBIT');
  }

  /**
   * Fetch the standing charges for a tariff over a given period.
   */
  async fetchStandingCharges(
    productCode: string,
    tariffCode: string,
    fuelType: 'electricity' | 'gas',
    periodFrom?: string,
    periodTo?: string,
  ): Promise<{ value_inc_vat: number; valid_from: string; valid_to: string | null; payment_method: string | null }[]> {
    const endpoint = fuelType === 'electricity' ? 'electricity-tariffs' : 'gas-tariffs';
    let url = `${BASE_URL}/products/${productCode}/${endpoint}/${tariffCode}/standing-charges/?page_size=1500`;
    if (periodFrom) url += `&period_from=${toUtcIso(periodFrom)}`;
    if (periodTo) url += `&period_to=${toUtcIso(periodTo)}`;
    const rates = await this.fetchAllPages<{ value_inc_vat: number; valid_from: string; valid_to: string | null; payment_method: string | null }>(url);
    return rates.filter(r => !r.payment_method || r.payment_method === 'DIRECT_DEBIT');
  }

  /**
   * Find the currently-live Tracker product without needing to know the user's
   * current tariff. Tracker products are not listed by the public /products/ API,
   * so we must fetch by code directly.
   *
   * We find a valid seed by stepping backwards month by month from today, probing
   * SILVER-YY-MM-01 until we get a 200. From there we walk the available_to chain
   * forward until we reach the live version (available_to === null).
   *
   * Returns { productCode, fullName } for the live version, or null on failure.
   */
  async findLiveTrackerProduct(): Promise<{ productCode: string; fullName: string } | null> {
    // Tracker tariffs align with quarters (Jan, Apr, Jul, Oct), so probe quarter
    // start dates stepping backwards — at most a handful of requests before hitting
    // a valid product, avoiding unnecessary API calls mid-quarter.
    const candidates: string[] = [];
    const now = new Date();
    const quarterMonth = (m: number) => [1, 4, 7, 10][Math.floor(m / 3)]; // 0-indexed month → quarter start month (1-indexed)
    let year = now.getFullYear();
    let month = quarterMonth(now.getMonth()); // start at the current quarter
    for (let i = 0; i < 8; i++) {
      const yy = String(year).slice(-2);
      const mm = String(month).padStart(2, '0');
      candidates.push(`SILVER-${yy}-${mm}-01`);
      // Step back one quarter
      month -= 3;
      if (month < 1) { month += 12; year -= 1; }
    }

    // Find the first candidate that exists
    let currentCode: string | null = null;
    for (const candidate of candidates) {
      try {
        const res = await fetch(`${BASE_URL}/products/${candidate}/`);
        if (res.ok) {
          currentCode = candidate;
          break;
        }
      } catch {
        // try next
      }
    }
    if (!currentCode) return null;

    // Walk the available_to chain forward to the live version
    for (let hop = 0; hop < 12; hop++) {
      try {
        const res = await fetch(`${BASE_URL}/products/${currentCode}/`);
        if (!res.ok) break;
        const data = await res.json();

        if (data.available_to === null) {
          return { productCode: currentCode, fullName: data.full_name };
        }

        const nextDate = new Date(data.available_to);
        const yy = String(nextDate.getFullYear()).slice(-2);
        const mm = String(nextDate.getMonth() + 1).padStart(2, '0');
        const dd = String(nextDate.getDate()).padStart(2, '0');
        const nextCode = `SILVER-${yy}-${mm}-${dd}`;

        if (nextCode === currentCode) break;
        currentCode = nextCode;
      } catch {
        break;
      }
    }

    return null;
  }

  /**
   * Given a Tracker product code like "SILVER-25-04-15", find the currently-active
   * Tracker product by following the chain of successor versions.
   *
   * Each Tracker product's `available_to` date is the `available_from` of the next
   * version, and the product code encodes that date as SILVER-YY-MM-DD. So we can
   * walk the chain with at most a handful of fetches rather than probing blindly.
   *
   * Returns the current product's code and tariff code for the given region, or null
   * if the user is already on the current version or none can be found.
   */
  async findCurrentTrackerProduct(
    baseProductCode: string,
    regionLetter: string,
    fuelType: 'electricity' | 'gas',
  ): Promise<{ productCode: string; tariffCode: string; fullName: string } | null> {
    const prefix = baseProductCode.split('-')[0];
    const region = regionLetter.replace('_', '');
    const fuelPrefix = fuelType === 'electricity' ? 'E' : 'G';

    let currentCode = baseProductCode;

    // Walk the chain: each product's available_to tells us the next product code.
    // Cap at 10 hops to prevent infinite loops.
    for (let hop = 0; hop < 10; hop++) {
      try {
        const res = await fetch(`${BASE_URL}/products/${currentCode}/`);
        if (!res.ok) break;
        const data = await res.json();

        // available_to null means this IS the current live version
        if (data.available_to === null) {
          // Only return it if it's different from where we started
          if (currentCode === baseProductCode) return null;
          const tariffCode = `${fuelPrefix}-1R-${currentCode}-${region}`;
          return { productCode: currentCode, tariffCode, fullName: data.full_name };
        }

        // Derive the next product code from available_to date: "2025-09-02T..." → "SILVER-25-09-02"
        const nextDate = new Date(data.available_to);
        const yy = String(nextDate.getFullYear()).slice(-2);
        const mm = String(nextDate.getMonth() + 1).padStart(2, '0');
        const dd = String(nextDate.getDate()).padStart(2, '0');
        const nextCode = `${prefix}-${yy}-${mm}-${dd}`;

        // Avoid looping if the derived code is the same
        if (nextCode === currentCode) break;
        currentCode = nextCode;
      } catch {
        break;
      }
    }

    return null;
  }
}
