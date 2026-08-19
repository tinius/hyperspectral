# Hyperspectral Methane Explorer

A static React and MapLibre demo built with Vite. The production build contains
only HTML, CSS, JavaScript and precomputed scene assets, so it can be hosted
directly on GitHub Pages.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Add your MapTiler API key to `.env.local`:

```text
VITE_MAPTILER_KEY=your_maptiler_api_key
```

## Production build

```bash
npm run build
npm run preview
```

The static site is written to `dist/`. Asset paths are relative, so the same
build works at a GitHub Pages repository subpath.

## GitHub Pages

The workflow in `.github/workflows/deploy.yml` builds and deploys `dist/` after
each push to `main`.

1. Open the repository’s **Settings → Secrets and variables → Actions**.
2. Add a repository secret named `MAPTILER_KEY`.
3. In **Settings → Pages**, choose **GitHub Actions** as the source.
4. Push to `main`, or run the workflow manually.

The MapTiler key is injected into the client build. Restrict the key to the
GitHub Pages domain in the MapTiler dashboard.

## Regenerating the wavelength scrubber

The scrubber uses 64 grayscale frames sampled across the Tanager radiance
cube. Generate them from the original HDF5 product with:

```bash
python scripts/prepare_band_scrubber.py /path/to/ortho_radiance.h5 \
  --output-dir public/data/bands --frames 64 --width 640
```

Each frame is independently stretched from its 1st to 99th radiance percentile
to preserve spatial detail across wavelengths. The images are therefore for
visual comparison of patterns, not absolute brightness. Low-signal atmospheric
water-absorption windows around 1,400 and 1,900 nm are excluded because sensor
noise and calibration artifacts dominate there.
