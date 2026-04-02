# Product Brief: Octopus Energy Tariff Comparison Tool

**Version:** 0.1 (Draft)
**Date:** April 2026
**Status:** For Review

---

## 1. Overview

A web-based tool that allows existing Octopus Energy customers to browse available tariffs and model what their energy costs would have been — or will be — under different tariff options. By connecting securely to the Octopus Energy REST API using their personal API key, users get a personalised, data-driven comparison rather than generic estimates.

---

## 2. Problem Statement

Octopus Energy offers a wide and growing range of tariffs — Agile, Flexible, Go, Cosy, Tracker, and more — each with meaningfully different pricing structures. Most customers have no easy way to answer the question:

> *"Would I actually be better off on a different tariff, given how and when I use energy?"*

Switching decisions are currently based on headline rates, not personal consumption patterns. This tool closes that gap.

---

## 3. Goals

- Enable customers to make **informed tariff decisions** based on their own real usage data
- Provide a **clear, accessible interface** that doesn't require technical knowledge
- Show customers **what they actually paid** and what they would have paid on alternative tariffs — using that historical picture as a reliable guide to future savings
- Respect user privacy — API keys are never stored server-side

---

## 4. Target Audience

**Primary:** Existing Octopus Energy customers with a smart meter (SMETS1 or SMETS2), comfortable enough to locate their API key from the Octopus dashboard.

**Secondary:** Technically curious customers looking to understand half-hourly pricing dynamics (e.g. Agile users).

---

## 5. Key Features

### 5.1 Account Connection
- User enters their **Octopus API key** and **account number** to authenticate
- API key is held only in browser session (never transmitted to or stored on any backend)
- On connection, the tool fetches account details: meter points (MPAN/MPRN), meter serial numbers, and current/previous tariffs
- The tool assumes a **single domestic dwelling** with one MPAN and one MPRN; multi-property accounts are out of scope

### 5.2 Tariff Browser
- Fetches and displays all **currently available Octopus products** via `GET /v1/products/`
- Filters to tariffs **available at the time the comparison is run** — legacy or grandfathered tariffs the user may currently be on are used as a baseline only, not offered as comparison targets
- Filters for: fuel type (electricity/gas), tariff type (variable, fixed, tracker, prepay, green), and region (derived from MPAN/MPRN)
- Shows for each tariff: display name, description, unit rate(s), standing charge, and term length
- Handles **regional tariff variants** — presents the correct tariff code for the user's Grid Supply Point (GSP)

### 5.3 Consumption Import
- Fetches **half-hourly electricity consumption** via `GET /v1/electricity-meter-points/{mpan}/meters/{serial}/consumption/`
- Fetches **half-hourly gas consumption** via `GET /v1/gas-meter-points/{mprn}/meters/{serial}/consumption/`
- Electricity and gas are always compared **like-for-like within each fuel type** — the tool compares electricity tariffs against electricity tariffs, and gas tariffs against gas tariffs; cross-fuel substitution (e.g. replacing gas heating with a heat pump) is out of scope
- Dual-fuel customers see costs broken down per fuel and as a combined total
- Allows user to select a **date range** for analysis (e.g. last 30, 90, 365 days)
- Handles SMETS1 vs SMETS2 differences (gas: m³ vs kWh conversion)
- Gracefully surfaces data gaps (common with SMETS1 meters)
- **Electricity export** (e.g. solar generation fed back to the grid) is out of scope for v1 but planned for Phase 2

### 5.4 Cost Modelling Engine
- The core question the engine answers is: **"given my actual consumption, what would I have paid if I had been on a different tariff over the same period?"**
- Actual consumption data is fixed and immutable — the variable is the unit rate applied to each half-hourly slot
- For each comparison tariff, the engine fetches the **rates that tariff charged at each point in time** over the analysis period and applies them to the actual consumption — e.g. if Agile was 8p/kWh at 2am on a Tuesday in November, that rate is applied to the consumption recorded in that slot
- Only tariffs **currently available to switch to** are eligible as comparison targets — there is no value in comparing against a tariff the user cannot actually move to
- The **Ofgem Price Cap** for the user's region is included as a standard reference baseline for both electricity and gas, applying the historically accurate quarterly cap rates and standing charges for each point in the analysis period
- Models **electricity and gas independently**, then combines into a total dual-fuel cost where applicable; fuel types are always compared like-for-like
- **Time-of-use tariffs** (Agile, Go, Cosy): fetches historical half-hourly unit rates and multiplies against half-hourly consumption slot by slot
- **Fixed/variable tariffs**: fetches the unit rate and standing charge applicable at each point in the period
- **Standing charges** are included in all cost calculations by default; the user can toggle standing charges on/off to isolate pure unit rate cost comparisons
- Outputs per fuel and combined: total cost, average daily cost, average unit rate paid, and standing charge total
- The purpose of the comparison is explicitly **retrospective as a guide to future decisions** — the tool does not project forward or attempt to predict future consumption or pricing

### 5.5 Comparison View
- Side-by-side comparison of up to **4 tariffs** simultaneously
- Summary table: total cost, savings vs current tariff, average p/kWh
- Visual chart: cumulative cost over time per tariff
- For time-of-use tariffs: heatmap or chart of hourly price patterns vs user's actual consumption patterns
- Highlights the **best-value tariff** for the user's specific usage profile

### 5.6 Current Tariff Baseline & Ofgem Reference
- Automatically detects the user's **current tariff** from their account data
- The baseline is **what the user actually paid** — derived from their real consumption multiplied by the rates on their actual tariff at each point in time, including any mid-period tariff changes
- This is presented as the primary reference figure against which all comparison tariffs are measured
- The **Ofgem Price Cap** is shown alongside as a secondary benchmark for both electricity and gas, using quarterly cap rates and regional standing charges accurate to each point in the analysis period
- Ofgem cap data is not available via API; it is maintained as a **bundled static lookup** (quarterly unit rates and standing charges by region, for both electricity and gas), updated when Ofgem publishes new cap levels each quarter

---

## 6. API Endpoints Used

| Endpoint | Purpose | Auth Required |
|---|---|---|
| `GET /v1/products/` | List all available tariffs | No |
| `GET /v1/products/{code}/` | Tariff detail & regional rates | No |
| `GET /v1/products/{code}/electricity-tariffs/{tariff}/standard-unit-rates/` | Historical/current unit rates | No |
| `GET /v1/products/{code}/electricity-tariffs/{tariff}/standing-charges/` | Standing charge history | No |
| `GET /v1/accounts/{account}/` | Account, meter, and tariff info | Yes |
| `GET /v1/electricity-meter-points/{mpan}/meters/{serial}/consumption/` | Half-hourly electricity usage | Yes |
| `GET /v1/gas-meter-points/{mprn}/meters/{serial}/consumption/` | Half-hourly gas usage | Yes |
| `GET /v1/industry/grid-supply-points/?postcode={postcode}` | Resolve region from postcode | No |

---

## 7. Out of Scope (v1)

- Switching / signing up to a new tariff (no write operations)
- Business tariffs
- Electricity export / solar generation comparison (planned for Phase 2)
- Cross-fuel substitution modelling (e.g. "what if I switched to a heat pump") — planned for Phase 2
- Multi-property accounts
- Mobile native app (web-first)
- Notifications or ongoing monitoring

---

## 8. Data & Privacy Considerations

- The API key grants read access to a customer's personal energy data; users must be clearly informed of this
- API keys must **only be stored in browser session/memory** — never in localStorage, cookies, or transmitted to a server
- No user data should be retained between sessions
- The tool should link to Octopus's guidance on API key generation and revocation
- A clear **"Disconnect"** action that clears the session

---

## 9. Technical Constraints & Notes

- The tool must run **entirely in the browser with no server-side layer** — all API calls are made directly from the client, and no user data is proxied through or stored on any backend
- All API requests must be made over **HTTPS**
- The Octopus API uses **pagination** (default page size 100, maximum 1,500 for price endpoints); the tool must handle multi-page responses for products and consumption data
- Consumption data availability varies: SMETS1 data can lag by hours or days — the tool should communicate this to users rather than showing errors
- Half-hourly data for Agile pricing uses **UTC timestamps**; daylight saving must be handled carefully in display
- Rate limits are not officially documented but requests should be batched/throttled sensibly

---

## 10. Success Metrics

- User can successfully connect their account and see a comparison within **under 2 minutes**
- Comparison results are accurate to within **±1%** of actual billed amounts
- The tool clearly identifies the **cheapest tariff** for the user's usage profile
- Users understand the output without needing to read documentation

---

## 11. Suggested Phased Delivery

| Phase | Scope |
|---|---|
| **Phase 1 — Foundation** | Account connection, tariff browser, electricity and gas consumption fetch, dual-fuel cost modelling |
| **Phase 2 — Comparison** | Side-by-side comparison view, cumulative cost charts, best-tariff recommendation; electricity export (solar) support |
| **Phase 3 — Polish** | Heatmap view of hourly price vs consumption patterns, current tariff baseline, edge case handling (SMETS1 gaps, legacy tariffs) |
| **Phase 4 — Stretch** | Export comparison to PDF/CSV, enhanced export meter/solar analysis |

---

## 12. Open Questions

1. The Ofgem Price Cap static lookup will need to be updated quarterly. Should this be a manually maintained JSON file bundled with the tool, or should the tool detect when cap data is stale and prompt the maintainer? Who owns that update process?

---

*Brief prepared for product scoping. Subject to revision following technical spike and stakeholder review.*
