# Hyperspectral Methane Explorer

A static React and MapLibre demo built with Vite. The production build contains
only HTML, CSS, JavaScript and precomputed scene assets, so it can be hosted
directly on GitHub Pages.

## Local development

Requires Node.js 20.19 or newer.

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
