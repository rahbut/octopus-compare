# Octopus Compare

A privacy-first, fully client-side web app for UK [Octopus Energy](https://octopus.energy) customers to visualise their energy usage and compare the cost of every available Octopus tariff against their real consumption data.

---

## Features

- **Usage view** — Half-hourly electricity (import & export) and gas consumption with costs derived from your actual tariff. Supports 7-day, 30-day, and 12-month presets plus side-by-side period-on-period comparison.
- **Tracker view** — Automatically shown for Octopus Tracker customers. Displays yesterday/today/tomorrow unit rates, trend chart, and savings vs Flexible Octopus over your selected period.
- **Compare view** — Applies your real consumption to every tariff currently available on Octopus, plus the Ofgem Price Cap as a reference benchmark. Produces a sortable table of total cost, standing charges, effective rate, and savings/surplus vs your current tariff.
- **Privacy-first** — Your API key is held only in React session state. It is never written to `localStorage`, cookies, or any server.

---

## Tech stack

| Layer | Technology |
|---|---|
| UI | React 19, TypeScript 5 |
| Build / dev server | Vite 8 |
| Charts | Recharts 3 |
| Styling | Plain CSS with dark/light theme toggle |
| Data pipeline | Python 3 (`requests`, `openpyxl`) |

---

## Getting started

### Prerequisites

- Node.js 18+ and npm
- An Octopus Energy account with a smart meter

### Find your credentials

1. Log in to your Octopus account at [octopus.energy](https://octopus.energy).
2. Go to **Account → Personal details** to find your **account number** (e.g. `A-XXXXXXXX`).
3. Go to **Account → Personal details → API access** to generate a **personal API key**.

### Run locally

```bash
cd webapp
npm install
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173), enter your API key and account number, and you're in.

---

## Available scripts

Run these from the `webapp/` directory:

| Script | Command | Description |
|---|---|---|
| `npm run dev` | `vite` | Start local dev server with HMR |
| `npm run build` | `tsc -b && vite build` | Type-check then produce a production bundle in `dist/` |
| `npm run preview` | `vite preview` | Serve the production build locally |
| `npm run lint` | `eslint .` | Run ESLint over all TypeScript/TSX source files |

---

## Updating Ofgem price cap data

The Ofgem price cap data is bundled as a static JSON file and needs a manual update each quarter when Ofgem publishes new figures.

### Prerequisites

```bash
pip install requests openpyxl
```

### Steps

1. Visit the [Ofgem price cap page](https://www.ofgem.gov.uk/check-if-energy-price-cap-affects-you) and locate the latest **Annex 9** XLSX download URL.
2. Add the new URL to the `ANNEX9_QUARTERS` list in `OfgemData/build_ofgem_data.py`.
3. Run the script from the `OfgemData/` directory:
   ```bash
   cd OfgemData
   python build_ofgem_data.py
   ```
4. Copy the output to the webapp:
   ```bash
   cp OfgemData/ofgem-price-cap.json webapp/src/data/ofgem-price-cap.json
   ```
5. Rebuild or restart the dev server.

---

## Privacy

No credentials are ever persisted. Your API key and account number exist only in React component state for the duration of your browser session. Closing or refreshing the tab clears them entirely.

All API calls are made directly from your browser to the Octopus Energy API — there is no intermediary server.

---

## Contributing

Contributions are welcome. Please open an issue to discuss any significant changes before submitting a pull request.

---

## Licence

[MIT](LICENSE)
