# Product Brief: Octopus Energy Tariff Comparison Tool

**Version:** 0.2 (Draft)
**Date:** April 2026
**Status:** For Review

---

## 1. Overview

A web-based tool that allows existing Octopus Energy customers to connect their account and immediately see their energy consumption data across all meters, then compare what that consumption would have cost under different tariffs. Running entirely in the browser with no server layer, it gives customers a personalised, data-driven view of their usage and a clear answer to the question: *"Would I be better off on a different tariff?"*

---

## 2. Problem Statement

Octopus Energy offers a wide and growing range of tariffs — Agile, Flexible, Go, Cosy, Tracker, and more — each with meaningfully different pricing structures. Most customers face two connected problems:

1. **No easy view of their own usage.** The Octopus app surfaces bills and basic consumption, but doesn't make it easy to understand usage patterns across fuels, compare this week to last week, or see import and export side by side.
2. **No informed basis for switching.** Switching decisions are based on headline rates, not personal consumption patterns. A customer on a legacy tariff has no easy way to know whether a currently available tariff would save them money.

This tool addresses both problems.

---

## 3. Goals

- Give customers an **immediate, clear view of their own energy usage** across all meters as soon as they connect their account
- Enable customers to make **informed tariff decisions** based on their actual consumption patterns, in both kWh and cost
- Provide **period comparisons** — week-on-week, month-on-month, year-on-year — in both consumption and cost
- Show what the user's consumption would have cost on **alternative tariffs currently available to switch to**, as well as the Ofgem Price Cap benchmark
- Respect user privacy — API keys are held only in browser session memory and never transmitted to any backend

---

## 4. Target Audience

**Primary:** Existing Octopus Energy customers with a smart meter (SMETS1 or SMETS2), comfortable enough to locate their API key from the Octopus dashboard.

**Secondary:** Technically curious customers — particularly those on or considering time-of-use tariffs like Agile — who want to understand their half-hourly usage patterns and pricing dynamics in detail.

---

## 5. Key Features

### 5.1 Account Connection
- User enters their **Octopus API key** and **account number** to authenticate
- API key is held only in browser session memory — never stored in localStorage, cookies, or transmitted to any backend
- On connection, the tool fetches account details: all meter points (MPAN/MPRN), meter serial numbers, current and previous tariffs, and GSP region
- The tool assumes a **single domestic dwelling** — one electricity MPAN and one gas MPRN; multi-property accounts are out of scope
- A clear **"Disconnect"** action wipes the session entirely

### 5.2 Usage Dashboard
The primary view on first connection. Shows the user their own data immediately, before any comparison is requested.

- Displays consumption data for **all available meters**:
  - Electricity import (all customers with a smart meter)
  - Electricity export (customers with solar/generation, where data is available)
  - Gas (dual-fuel customers)
- Each meter is shown with **both kWh consumption and £ cost side by side**
- Cost is derived from the user's actual tariff rates at each point in time — what they genuinely paid
- **Fixed time period presets:** Last 7 days, Last 30 days, Last 12 months — switchable without re-fetching all data
- **Period comparison:** user can compare any preset period against the equivalent prior period (e.g. last 7 days vs the 7 days before that; last 12 months vs the 12 months before that), shown side by side in both kWh and £
- Visualisations include:
  - Half-hourly or daily bar/line charts per meter
  - Summary totals (kWh and £) per period
  - Comparison delta — how much more or less was used/spent vs the prior period
- Data gaps (common with SMETS1 meters) are shown clearly rather than silently omitted
- SMETS1 vs SMETS2 differences handled transparently (gas m³ to kWh conversion where applicable)

### 5.3 Tariff Comparison View
A separate view the user switches to from the usage dashboard. Takes the same consumption data and asks: *what would this have cost on a different tariff?*

- User selects a **date range for analysis** (defaults to last 12 months; adjustable via the same period presets)
- The tool fetches all **tariffs currently available to switch to** via `GET /v1/products/`, filtered to the user's region (GSP) and fuel type
- Legacy or grandfathered tariffs the user may currently be on are used as the baseline only — not offered as comparison targets
- **Electricity and gas are compared like-for-like** — electricity tariffs against electricity consumption, gas tariffs against gas consumption; cross-fuel substitution is out of scope
- For each comparison tariff, the engine applies the **rates that tariff charged at each point in time** to the user's actual half-hourly consumption — not a flat average rate applied retrospectively
- The **Ofgem Price Cap** for the user's region is included as a standard reference benchmark, applying historically accurate quarterly rates for both electricity and gas throughout the analysis period
- Results shown for up to **4 tariffs simultaneously**, side by side, in both kWh-weighted average rate (p/kWh) and total £ cost
- **Standing charges** are included by default; the user can toggle them off to isolate unit rate comparisons
- The comparison clearly identifies the **cheapest available tariff** for the user's specific usage profile
- Visual chart of **cumulative cost over time** per tariff
- For time-of-use tariffs (Agile, Go, Cosy): a **heatmap or hourly chart** overlaying the tariff's price pattern against the user's actual consumption pattern — showing whether the user's usage habits suit the tariff

### 5.4 Current Tariff Baseline
- Automatically detected from the user's account data
- Baseline is **what the user actually paid** — consumption multiplied by the rates on their actual tariff(s) at each point in time, correctly handling any mid-period tariff changes
- Shown as the reference figure in both the usage dashboard (as actual cost) and the comparison view (as the benchmark to beat)

---

## 6. Navigation & Layout

- The tool has **two primary views**, switchable at any time:
  - **Usage** — the default view on first connection; shows consumption and cost across all meters with period comparisons
  - **Compare** — the tariff comparison engine; uses the same consumption data already loaded
- Switching between views does not require re-fetching data
- Both views are usable on mobile-sized screens

---

## 7. API Endpoints Used

| Endpoint | Purpose | Auth Required |
|---|---|---|
| `GET /v1/products/` | List all currently available tariffs | No |
| `GET /v1/products/{code}/` | Tariff detail & regional rates | No |
| `GET /v1/products/{code}/electricity-tariffs/{tariff}/standard-unit-rates/` | Historical/current unit rates | No |
| `GET /v1/products/{code}/electricity-tariffs/{tariff}/standing-charges/` | Standing charge history | No |
| `GET /v1/accounts/{account}/` | Account, meter, and tariff info | Yes |
| `GET /v1/electricity-meter-points/{mpan}/meters/{serial}/consumption/` | Half-hourly electricity import | Yes |
| `GET /v1/electricity-meter-points/{mpan}/meters/{serial}/consumption/` | Half-hourly electricity export (where available) | Yes |
| `GET /v1/gas-meter-points/{mprn}/meters/{serial}/consumption/` | Half-hourly gas usage | Yes |
| `GET /v1/industry/grid-supply-points/?postcode={postcode}` | Resolve GSP region from postcode | No |

---

## 8. Out of Scope (v1)

- Switching / signing up to a new tariff (no write operations)
- Business tariffs
- Cross-fuel substitution modelling (e.g. "what if I switched to a heat pump")
- SEG (Smart Export Guarantee) tariff comparison for export revenue — export data is *shown* in the usage dashboard but tariff comparison for export revenue is deferred to Phase 3
- Multi-property accounts
- Mobile native app (web-first)
- Notifications or ongoing monitoring

---

## 9. Data & Privacy Considerations

- The API key grants read access to a customer's personal energy data; users must be clearly informed of this before connecting
- API keys must **only be stored in browser session/memory** — never in localStorage, cookies, or transmitted to any server
- No user data is retained between sessions
- The tool should link to Octopus's guidance on API key generation and revocation
- A clear **"Disconnect"** action clears the session immediately

---

## 10. Technical Constraints & Notes

- The tool runs **entirely in the browser with no server-side layer** — all API calls are made directly from the client
- This is confirmed viable: the Octopus API returns `Access-Control-Allow-Origin: *` on its responses, meaning direct browser requests are explicitly permitted without a CORS proxy
- All API requests must be made over **HTTPS**
- The Octopus API uses **pagination** (default page size 100, maximum 1,500 for price endpoints); the tool must handle multi-page responses for products and consumption data
- Consumption data availability varies: SMETS1 data can lag by hours or days — the tool should surface this clearly rather than showing errors
- Half-hourly timestamps use **UTC**; daylight saving must be handled carefully in display
- Rate limits are not officially documented; requests should be batched and throttled sensibly — fetching a year of half-hourly data across multiple meters and tariffs involves significant API call volume
- The **Ofgem Price Cap** reference data is bundled as a static JSON file (`ofgem-price-cap.json`), generated by a provided Python script (`build_ofgem_data.py`) and updated manually each quarter when Ofgem publishes new cap levels

---

## 11. Success Metrics

- User connects their account and sees their usage dashboard within **under 2 minutes**
- Usage data is presented clearly enough that the user understands their consumption patterns **without needing documentation**
- Tariff comparison results are accurate to within **±1%** of actual billed amounts
- The tool clearly identifies the **cheapest currently available tariff** for the user's usage profile
- Period comparisons make it immediately obvious whether usage is trending up or down

---

## 12. Suggested Phased Delivery

| Phase | Scope |
|---|---|
| **Phase 1 — Foundation** | Account connection, usage dashboard (electricity import + gas), period presets, period-on-period comparison in kWh and £ |
| **Phase 2 — Comparison** | Tariff comparison engine, side-by-side cost view, Ofgem benchmark, standing charge toggle, best-tariff recommendation |
| **Phase 3 — Full Meter Support** | Electricity export display in usage dashboard; SEG tariff comparison for export revenue |
| **Phase 4 — Polish** | Time-of-use heatmap, cumulative cost charts, edge case handling (SMETS1 gaps, mid-period tariff changes) |
| **Phase 5 — Stretch** | Export comparison to PDF/CSV, heat pump "what if" modelling |

---

## 13. Open Questions

All questions resolved. No outstanding items.

---

*Brief prepared for product scoping. Subject to revision following technical spike and stakeholder review.*
