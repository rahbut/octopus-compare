import { useState, useEffect, useMemo } from 'react';
import { OctopusApi, type OctopusAccount, type Product, type ConsumptionResult } from './api';
import { CostEngine, type CostCalculation } from './CostEngine';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface DashboardProps {
  api: OctopusApi;
}

type Timeframe = '7days' | '30days' | '1year';

function aggregateConsumptionByDay(consumption: ConsumptionResult[]) {
  const dailyData: Record<string, number> = {};
  const sorted = [...consumption].sort((a, b) => new Date(a.interval_start).getTime() - new Date(b.interval_start).getTime());

  for (const item of sorted) {
    const dateObj = new Date(item.interval_start);
    const dateKey = dateObj.toISOString().split('T')[0];
    if (!dailyData[dateKey]) dailyData[dateKey] = 0;
    dailyData[dateKey] += item.consumption;
  }
  
  return Object.keys(dailyData).sort().map(dateKey => {
    const d = new Date(dateKey);
    return {
      date: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
      dateKey,
      kWh: Number(dailyData[dateKey].toFixed(2))
    };
  });
}

function aggregateConsumptionByMonth(consumption: ConsumptionResult[]) {
  const monthlyData: Record<string, number> = {};
  const sorted = [...consumption].sort((a, b) => new Date(a.interval_start).getTime() - new Date(b.interval_start).getTime());

  for (const item of sorted) {
    const dateObj = new Date(item.interval_start);
    const dateKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
    if (!monthlyData[dateKey]) monthlyData[dateKey] = 0;
    monthlyData[dateKey] += item.consumption;
  }
  
  return Object.keys(monthlyData).sort().map(dateKey => {
    const [year, month] = dateKey.split('-');
    const d = new Date(Number(year), Number(month) - 1, 1);
    return {
      date: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
      dateKey,
      kWh: Number(monthlyData[dateKey].toFixed(2))
    };
  });
}

export function Dashboard({ api }: DashboardProps) {
  const [account, setAccount] = useState<OctopusAccount | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Usage State
  const [selectedMeterId, setSelectedMeterId] = useState<string>('');
  const [timeframe, setTimeframe] = useState<Timeframe>('30days');
  const [consumptionData, setConsumptionData] = useState<ConsumptionResult[]>([]);
  const [isFetchingUsage, setIsFetchingUsage] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);

  // Cost Engine State
  const [selectedProduct, setSelectedProduct] = useState<string>('');
  const [isCalculating, setIsCalculating] = useState(false);
  const [calcResult, setCalcResult] = useState<CostCalculation | null>(null);

  useEffect(() => {
    async function loadInitialData() {
      try {
        setLoading(true);
        const [accData, prodData] = await Promise.all([
          api.getAccountDetails(),
          api.getProducts()
        ]);
        setAccount(accData);
        
        const domesticProducts = prodData.results.filter(p => !p.is_business);
        setProducts(domesticProducts);
        if (domesticProducts.length > 0) {
          setSelectedProduct(domesticProducts[0].code);
        }
        
        const elec = accData.properties[0]?.electricity_meter_points || [];
        const gas = accData.properties[0]?.gas_meter_points || [];
        
        const allMeters = [
          ...elec.map(m => m.mpan),
          ...gas.map(m => m.mprn)
        ].filter(Boolean) as string[];

        if (allMeters.length > 0) {
          setSelectedMeterId(allMeters[0]);
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    loadInitialData();
  }, [api]);

  useEffect(() => {
    if (!account || !selectedMeterId) return;
    const property = account.properties[0];
    
    let type: 'electricity' | 'gas' = 'electricity';
    let serial = '';
    
    const elecPoint = property?.electricity_meter_points?.find(m => m.mpan === selectedMeterId);
    if (elecPoint && elecPoint.meters[0]?.serial_number) {
      type = 'electricity';
      serial = elecPoint.meters[0].serial_number;
    } else {
      const gasPoint = property?.gas_meter_points?.find(m => m.mprn === selectedMeterId);
      if (gasPoint && gasPoint.meters[0]?.serial_number) {
        type = 'gas';
        serial = gasPoint.meters[0].serial_number;
      }
    }

    if (!serial) return;
    fetchUsage(type, selectedMeterId, serial, timeframe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, selectedMeterId, timeframe]);

  const fetchUsage = async (type: 'electricity'|'gas', id: string, serial: string, tf: Timeframe) => {
    setIsFetchingUsage(true);
    setUsageError(null);
    setCalcResult(null); // Reset comparison when timeframe changes

    try {
      const latestDateStr = await api.getLatestConsumptionDate(type, id, serial);
      if (!latestDateStr) {
        setConsumptionData([]);
        setIsFetchingUsage(false);
        return;
      }

      const to = new Date(latestDateStr);
      let days = 30;
      if (tf === '7days') days = 7;
      if (tf === '1year') days = 365;

      const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
      const fromIso = from.toISOString();
      const toIso = to.toISOString();
      
      const data = type === 'electricity' 
        ? await api.getElectricityConsumption(id, serial, fromIso, toIso)
        : await api.getGasConsumption(id, serial, fromIso, toIso);
      
      setConsumptionData(data);
    } catch (err: any) {
      setUsageError(err.message);
    } finally {
      setIsFetchingUsage(false);
    }
  };

  const chartData = useMemo(() => {
    if (!consumptionData.length) return [];
    if (timeframe === '1year') {
      return aggregateConsumptionByMonth(consumptionData);
    }
    return aggregateConsumptionByDay(consumptionData);
  }, [consumptionData, timeframe]);

  if (loading) return <div className="panel text-center text-secondary">Loading account and tariff data...</div>;
  if (error) return <div className="panel"><h3 style={{ color: 'var(--error-color)' }}>Error</h3><p>{error}</p></div>;
  if (!account) return null;

  const property = account.properties[0];
  const allMeters = useMemo(() => {
    const elec = property.electricity_meter_points || [];
    const gas = property.gas_meter_points || [];
    return [
      ...elec.map(m => ({ id: m.mpan!, type: 'Electricity' })),
      ...gas.map(m => ({ id: m.mprn!, type: 'Gas' }))
    ].filter(m => m.id);
  }, [property]);

  const runComparison = async () => {
    if (!consumptionData.length) return;
    setIsCalculating(true);
    setCalcResult(null);

    try {
      // Find min and max dates of the fetched consumption
      const sorted = [...consumptionData].sort((a,b) => new Date(a.interval_start).getTime() - new Date(b.interval_start).getTime());
      const fromIso = sorted[0].interval_start;
      const toIso = sorted[sorted.length-1].interval_end;

      // Determine if we are modelling electricity or gas based on the currently selected meter
      const meterInfo = allMeters.find(m => m.id === selectedMeterId);
      const fuelType = meterInfo?.type.toLowerCase() === 'gas' ? 'gas' : 'electricity';
      
      const tariffCode = fuelType === 'gas' ? `G-1R-${selectedProduct}-G` : `E-1R-${selectedProduct}-G`; 

      const rates = await CostEngine.fetchTariffRates(api, selectedProduct, tariffCode, fuelType, fromIso, toIso);

      const result = CostEngine.calculateCost(consumptionData, rates);
      setCalcResult(result);

    } catch (err: any) {
      alert("Error modelling cost: " + err.message);
    } finally {
      setIsCalculating(false);
    }
  };

  return (
    <div className="flex-col gap-4">
      {/* Account Info */}
      <div className="panel flex-col gap-2">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ marginBottom: 0 }}>Account {account.number}</h2>
            {property?.address_line_1 && <p className="text-secondary" style={{ marginTop: '0.2rem' }}>{property.address_line_1}</p>}
          </div>
          <div className="panel" style={{ background: 'var(--bg-color)', padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <span className="text-secondary" style={{ fontSize: '0.85rem' }}>Select Meter:</span>
            <select 
              value={selectedMeterId} 
              onChange={e => setSelectedMeterId(e.target.value)}
              style={{ padding: '0.25rem', borderRadius: '4px', background: 'var(--panel-bg)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
            >
              {allMeters.map(m => (
                <option key={m.id} value={m.id}>{m.type}: {m.id}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Usage Section */}
      <div className="panel flex-col gap-2">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2>Usage Data</h2>
          <select 
            value={timeframe} 
            onChange={e => setTimeframe(e.target.value as Timeframe)}
            style={{ padding: '0.5rem', borderRadius: '6px', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
          >
            <option value="7days">Last 7 Days</option>
            <option value="30days">Last 30 Days</option>
            <option value="1year">This Year</option>
          </select>
        </div>

        {isFetchingUsage ? (
          <div className="text-center text-secondary" style={{ padding: '3rem 0' }}>Fetching actual consumption data...</div>
        ) : usageError ? (
          <div className="text-center" style={{ color: 'var(--error-color)', padding: '2rem 0' }}>{usageError}</div>
        ) : chartData.length > 0 ? (
          <div style={{ width: '100%', height: 350, marginTop: '1rem' }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 20, right: 30, left: 0, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                <XAxis dataKey="date" stroke="var(--text-secondary)" tick={{fontSize: 12}} />
                <YAxis stroke="var(--text-secondary)" tick={{fontSize: 12}} unit=" kWh" />
                <Tooltip 
                  cursor={{fill: 'rgba(255, 255, 255, 0.05)'}} 
                  contentStyle={{ backgroundColor: 'var(--panel-bg)', borderColor: 'var(--border-color)', color: 'var(--text-primary)', borderRadius: '8px' }} 
                />
                <Bar dataKey="kWh" fill="var(--accent-color)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="text-center text-secondary" style={{ padding: '3rem 0', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <span>No consumption data found for this period.</span>
            <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>If you have multiple MPANs (like an export meter), try selecting a different one above, or select 'This Year'.</span>
          </div>
        )}
      </div>

      {/* Comparison Section */}
      <div className="panel flex-col gap-2" style={{ opacity: isFetchingUsage ? 0.5 : 1, pointerEvents: isFetchingUsage ? 'none' : 'auto' }}>
        <h2>Compare Tariffs</h2>
        <p className="text-secondary">Model a tariff cost using the exact consumption data fetched above.</p>
        
        <div className="flex-row gap-2" style={{ alignItems: 'center', marginTop: '1rem' }}>
          <select 
            value={selectedProduct} 
            onChange={e => setSelectedProduct(e.target.value)}
            style={{ flex: 1, padding: '0.75rem', borderRadius: '6px', background: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
          >
            {products.map(p => (
              <option key={p.code} value={p.code}>{p.display_name} ({p.code})</option>
            ))}
          </select>
          <button onClick={runComparison} disabled={isCalculating || !consumptionData.length}>
            {isCalculating ? 'Modelling Costs...' : 'Model Costs ➔'}
          </button>
        </div>

        {calcResult && (
          <div className="mt-2 text-center" style={{ padding: '1.5rem', border: '1px dashed var(--accent-color)', borderRadius: '8px', background: 'rgba(229, 0, 122, 0.05)' }}>
            <h3 style={{ margin: '0 0 1rem 0' }}>Modelled Assessment (Against Usage Data)</h3>
            <div className="flex-row gap-4" style={{ justifyContent: 'center' }}>
              <div className="flex-col">
                <span className="text-secondary" style={{ fontSize: '0.9rem' }}>Total Cost</span>
                <span style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>£{(calcResult.totalCostPence / 100).toFixed(2)}</span>
              </div>
              <div className="flex-col">
                <span className="text-secondary" style={{ fontSize: '0.9rem' }}>Consumption</span>
                <span style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{calcResult.totalConsumptionKwh.toFixed(1)} kWh</span>
              </div>
              <div className="flex-col">
                <span className="text-secondary" style={{ fontSize: '0.9rem' }}>Avg Rate</span>
                <span style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{calcResult.averagePencePerKwh.toFixed(1)}p / kWh</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
