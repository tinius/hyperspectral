"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Map, {
  Layer,
  NavigationControl,
  Source,
  type MapLayerMouseEvent,
} from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";

type SceneMetadata = {
  scene: string;
  corners: [[number, number], [number, number], [number, number], [number, number]];
  center: [number, number];
  footprint: {
    type: "Polygon";
    coordinates: number[][][];
  };
  rasterWidth: number;
  rasterHeight: number;
  regionSize: number;
  regionColumns: number;
  regionRows: number;
  bands: number;
  wavelengths: number[];
  target: number[];
  curveQuantizationScale: number;
  curveNoData: number;
  scoreByRegion: number[][];
  scoreNoData: number;
  retrievalWindowNm: [number, number];
};

type HoverReading = {
  x: number;
  y: number;
  score: number;
  curve: number[];
};

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;
const MAP_STYLE = `https://api.maptiler.com/maps/hybrid-v4/style.json?key=${MAPTILER_KEY}`;
const BASEMAP_WASH = {
  type: "Feature" as const,
  properties: {},
  geometry: {
    type: "Polygon" as const,
    coordinates: [[
      [-180, -85],
      [180, -85],
      [180, 85],
      [-180, 85],
      [-180, -85],
    ]],
  },
};

function surfaceCoordinates(longitude: number, latitude: number, metadata: SceneMetadata) {
  const longitudes = metadata.corners.map((corner) => corner[0]);
  const latitudes = metadata.corners.map((corner) => corner[1]);
  return {
    u: (longitude - Math.min(...longitudes)) /
      (Math.max(...longitudes) - Math.min(...longitudes)),
    v: (Math.max(...latitudes) - latitude) /
      (Math.max(...latitudes) - Math.min(...latitudes)),
  };
}

function polygonCentroid(ring: number[][]): [number, number] {
  let crossSum = 0;
  let longitudeSum = 0;
  let latitudeSum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [longitude, latitude] = ring[index];
    const [nextLongitude, nextLatitude] = ring[index + 1];
    const cross = longitude * nextLatitude - nextLongitude * latitude;
    crossSum += cross;
    longitudeSum += (longitude + nextLongitude) * cross;
    latitudeSum += (latitude + nextLatitude) * cross;
  }
  if (Math.abs(crossSum) < 1e-12) {
    return [
      ring.reduce((sum, point) => sum + point[0], 0) / ring.length,
      ring.reduce((sum, point) => sum + point[1], 0) / ring.length,
    ];
  }
  return [
    longitudeSum / (3 * crossSum),
    latitudeSum / (3 * crossSum),
  ];
}

function SpectralTooltip({
  reading,
  metadata,
}: {
  reading: HoverReading;
  metadata: SceneMetadata;
}) {
  const width = 292;
  const height = 108;
  const normalizedCurve = useMemo(() => {
    const rms = Math.sqrt(
      reading.curve.reduce((sum, value) => sum + value * value, 0) /
        reading.curve.length,
    );
    return reading.curve.map((value) => value / Math.max(rms, 1e-8));
  }, [reading.curve]);
  // Keep a fixed, symmetric y-domain so the methane target never changes
  // shape or apparent amplitude as the user moves between regions.
  const extent = 4;
  const makePath = (values: number[]) =>
    values.map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * width;
      const unclippedY = height / 2 - (value / extent) * (height * 0.42);
      const y = Math.max(0, Math.min(height, unclippedY));
      return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  const label =
    reading.score >= 5
      ? "Strong methane signal"
      : reading.score >= 2
        ? "Medium methane signal"
        : "No methane signal";
  const labelClass =
    reading.score >= 5
      ? "strong"
      : reading.score >= 2
        ? "medium"
        : "none";

  return (
    <aside
      className="spectral-tooltip"
      style={{
        left: `min(calc(100% - 338px), ${reading.x + 18}px)`,
        top: `min(calc(100% - 250px), ${reading.y + 18}px)`,
      }}
      aria-live="polite"
    >
      <div className="tooltip-heading">
        <div>
          <span className={`signal-dot signal-${labelClass}`} />
          <strong>{label}</strong>
        </div>
      </div>
      <svg
        className="spectral-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Observed background-adjusted spectrum compared with the methane target"
      >
        <line x1="0" x2={width} y1={height / 2} y2={height / 2} className="zero-line" />
        <path d={makePath(metadata.target)} className="target-line" />
        <path d={makePath(normalizedCurve)} className="observed-line" />
      </svg>
      <div className="axis-labels">
        <span>{Math.round(metadata.retrievalWindowNm[0])} nm</span>
        <span>{Math.round(metadata.retrievalWindowNm[1])} nm</span>
      </div>
      <div className="chart-legend">
        <span><i className="legend-line observed" />Observed here</span>
        <span><i className="legend-line target" />Methane signature</span>
      </div>
      <p>Shape-normalized after subtracting spectrally similar surfaces.</p>
    </aside>
  );
}

export default function Home() {
  const [metadata, setMetadata] = useState<SceneMetadata | null>(null);
  const spectraRef = useRef<Int16Array | null>(null);
  const [reading, setReading] = useState<HoverReading | null>(null);
  const lastRegionRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/data/methane-scene.json").then((response) => response.json()),
      fetch("/data/hover-spectra.i16").then((response) => response.arrayBuffer()),
    ]).then(([scene, buffer]: [SceneMetadata, ArrayBuffer]) => {
      if (cancelled) return;
      spectraRef.current = new Int16Array(buffer);
      setMetadata(scene);
    });
    return () => { cancelled = true; };
  }, []);

  const handleMove = useCallback((event: MapLayerMouseEvent) => {
    if (!metadata || !spectraRef.current) return;
    // Do not update React state while MapLibre is handling a drag gesture.
    // Frequent tooltip rerenders during pointer movement can interrupt panning
    // and control-button gestures in embedded browsers.
    if ("buttons" in event.originalEvent && event.originalEvent.buttons !== 0) {
      return;
    }
    const { u, v } = surfaceCoordinates(event.lngLat.lng, event.lngLat.lat, metadata);
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      lastRegionRef.current = null;
      setReading(null);
      return;
    }
    const regionColumn = Math.min(
      metadata.regionColumns - 1,
      Math.floor((u * metadata.rasterWidth) / metadata.regionSize),
    );
    const regionRow = Math.min(
      metadata.regionRows - 1,
      Math.floor((v * metadata.rasterHeight) / metadata.regionSize),
    );
    const regionKey = `${regionRow}:${regionColumn}`;
    if (lastRegionRef.current === regionKey) return;
    lastRegionRef.current = regionKey;
    const score = metadata.scoreByRegion[regionRow][regionColumn];
    const start = (regionRow * metadata.regionColumns + regionColumn) * metadata.bands;
    const encoded = spectraRef.current.subarray(start, start + metadata.bands);
    if (
      score === metadata.scoreNoData ||
      encoded.length !== metadata.bands ||
      encoded[0] === metadata.curveNoData
    ) {
      setReading(null);
      return;
    }
    setReading({
      x: event.point.x,
      y: event.point.y,
      score,
      curve: Array.from(encoded, (value) => value * metadata.curveQuantizationScale),
    });
  }, [metadata]);

  const clearReading = useCallback(() => {
    lastRegionRef.current = null;
    setReading(null);
  }, []);

  const footprint = useMemo(() => {
    if (!metadata) return null;
    return {
      type: "Feature" as const,
      properties: {},
      geometry: {
        type: "Polygon" as const,
        coordinates: [metadata.footprint.coordinates[0]],
      },
    };
  }, [metadata]);

  const footprintCenter = useMemo(
    () => metadata
      ? polygonCentroid(metadata.footprint.coordinates[0])
      : [0, 0] as [number, number],
    [metadata],
  );

  if (!metadata) {
    return (
      <main className="loading-view">
        <span className="loading-mark" />
        <p>Preparing the methane scene…</p>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="scene-title">Working with hyperspectral satellite data, a tech demo by Niko Kommenda</div>
      </header>

      <section className="hero">
        {/* <span className="section-kicker">SEEING THE INVISIBLE</span> */}
        <div className="hero-grid">
          <h1>Going <em>hyperspectral</em> to find methane leaks</h1>
          <div className="hero-copy">
            <p>
              Most satellites looking at Earth capture only a few broad bands of light -- think red, green and blue.
              But satellites with hyperspectral sensors, like Planet's Tanager-1, divide the spectrum into hundreds of narrow bands,
              unlocking new kinds of analysis. 
            </p>
            <p>
              One application is the detection of methane, a potent greenhouse gas that's invisible to the naked eye.
              The gas absorbs light at a series of very specific wavelengths,
              leaving a spectral "fingerprint" that shows up in the data captured by Tanager-1.
            </p>
          </div>
        </div>

        <div className="spectrum-explainer">
          <div className="spectrum-heading">
            <strong>The electromagnetic spectrum captured by Tanager-1</strong>
            <span>Wavelength in nanometres</span>
          </div>
          <div
            className="spectrum-track"
            aria-label="Wavelength chart from visible light to shortwave infrared"
          >
            <div className="visible-range"><span>Visible light</span></div>
            <div className="near-infrared-range"><span>Near infrared</span></div>
            <div className="shortwave-range"><span>Shortwave infrared</span></div>
            <div className="methane-window"><span>Methane window</span></div>
          </div>
          <div className="spectrum-ticks">
            <span style={{ left: "0%" }}>400</span>
            <span style={{ left: "14.3%" }}>700</span>
            <span style={{ left: "47.6%" }}>1,400</span>
            <span style={{ left: "81%" }}>2,100</span>
            <span style={{ left: "97.6%" }}>2,450</span>
          </div>
          <p className="spectrum-note">
            The map below focuses on the 2,100–2,450 nm region, where methane
            leaves a strong, structured absorption fingerprint.
          </p>
        </div>
      </section>

      <section className="method-bridge">
        <div className="method-bridge-grid">
          <h2>Matching methane’s spectral signature</h2>
          <div>
            <p>
            Planet and other groups use sophisticated algorithms to estimate methane concentrations and emission rates
            from hyperspectral imagery. This demo takes a simpler approach to illustrate the underlying idea.
            </p>
            <p>
              After subtracting background noise,
              the algorithm looks at how closely a pixel resembles methane's
              absorption fingerprint inside a key window of wavelengths.
            </p>
            <p>
              The map below demonstrates the algorithm on an example scene, revealing a large methane plume over a
              gas processing plant in Punjab, Pakistan.
            </p>
          </div>
        </div>
      </section>

      <section className="map-stage" onMouseLeave={clearReading}>
        <Map
          initialViewState={{
            longitude: 69.808,
            latitude: 27.99,
            zoom: 11.5,
          }}
          mapStyle={MAP_STYLE}
          style={{ width: "100%", height: "100%" }}
          onMouseMove={handleMove}
          cursor="crosshair"
          minZoom={9.2}
          maxZoom={12.2}
          dragPan
          dragRotate={false}
          scrollZoom={false}
          doubleClickZoom
          touchZoomRotate
          keyboard
          attributionControl
        >
          <NavigationControl position="bottom-right" showCompass={false} />
          <Source id="basemap-wash" type="geojson" data={BASEMAP_WASH}>
            <Layer
              id="basemap-wash-layer"
              type="fill"
              paint={{
                "fill-color": "#f3f0ea",
                "fill-opacity": 0.28,
              }}
            />
          </Source>
          <Source
            id="methane-score"
            type="image"
            url="/data/methane-score.png"
            coordinates={metadata.corners}
          >
            <Layer
              id="methane-score-layer"
              type="raster"
              paint={{
                "raster-opacity": 1,
                "raster-resampling": "linear",
                "raster-fade-duration": 0,
              }}
            />
          </Source>
          {footprint && (
            <Source id="satellite-footprint" type="geojson" data={footprint}>
              <Layer
                id="satellite-footprint-line"
                type="line"
                layout={{
                  "line-cap": "round",
                  "line-join": "round",
                }}
                paint={{
                  "line-color": "#111111",
                  "line-width": 2,
                  "line-opacity": 0.9,
                  "line-dasharray": [1.2, 1.8],
                }}
              />
            </Source>
          )}
        </Map>

        <div className="signal-legend" aria-label="Methane signal legend">
          <div className="legend-title">
            <span>Methane signal</span>
            <span>relative strength</span>
          </div>
          <div className="continuous-scale">
            <i className="scale-marker marker-none" />
            <i className="scale-marker marker-medium" />
            <i className="scale-marker marker-strong" />
          </div>
          <div className="category-labels">
            <span>None</span>
            <span>Medium</span>
            <span>Strong</span>
          </div>
        </div>

        {!reading && (
          <div className="hover-hint">
            <span className="crosshair-icon">＋</span>
            Hover inside the scene to inspect the spectral signature
          </div>
        )}
        {reading && <SpectralTooltip reading={reading} metadata={metadata} />}
      </section>

      <footer className="footnote">
        <p>
          The score measures resemblance to methane after removing the expected
          spectrum of similar surfaces. It indicates spectral evidence, not
          methane concentration. The reference signature is adapted from the
          modeled methane absorption coefficient published in NASA’s{" "}
          <a
            href="https://nasa.github.io/LPDAAC-Data-Resources/external/Generating_Methane_Spectral_Fingerprint.html"
            target="_blank"
            rel="noreferrer"
          >
            EMIT methane tutorial
          </a>. The interactive tooltip in the map shows spectral information averaged over 5x5 pixels.
        </p>
      </footer>
    </main>
  );
}
