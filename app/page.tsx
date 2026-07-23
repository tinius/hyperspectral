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
  const extent = Math.max(
    1.8,
    ...normalizedCurve.map((value) => Math.abs(value)),
    ...metadata.target.map((value) => Math.abs(value)),
  );
  const makePath = (values: number[]) =>
    values.map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * width;
      const y = height / 2 - (value / extent) * (height * 0.42);
      return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  const label =
    reading.score >= 5
      ? "Strong methane signal"
      : reading.score >= 3
        ? "Medium methane signal"
        : reading.score >= 2
          ? "Weak methane signal"
          : "Insufficient methane signal";
  const labelClass =
    reading.score >= 5
      ? "strong"
      : reading.score >= 3
        ? "medium"
        : reading.score >= 2
          ? "weak"
          : "insufficient";

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
        <span><i className="legend-line target" />Methane target</span>
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
        <div className="scene-title">Hyperspectral methane explorer</div>
      </header>

      <section className="hero">
        <span className="section-kicker">SEEING THE INVISIBLE</span>
        <div className="hero-grid">
          <h1>Finding methane<br />between the colours.</h1>
          <div className="hero-copy">
            <p>
              Ordinary cameras combine light into red, green and blue.
              Hyperspectral satellites divide the spectrum into hundreds of
              narrow bands—including wavelengths invisible to the human eye.
            </p>
            <p>
              Molecules absorb light at distinctive wavelengths. By looking for
              methane’s characteristic pattern, satellites can reveal harmful
              gas plumes that would otherwise remain unseen.
            </p>
          </div>
        </div>

        <div className="spectrum-explainer">
          <div className="spectrum-heading">
            <strong>The electromagnetic spectrum captured by Tanager</strong>
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
            <span style={{ left: "100%" }}>2,500</span>
          </div>
          <p className="spectrum-note">
            The map below searches the 2,102–2,449 nm region, where methane
            leaves a strong, structured absorption fingerprint.
          </p>
        </div>
      </section>

      <section className="method-bridge">
        <span className="section-kicker">FROM MEASUREMENT TO DETECTION</span>
        <div className="method-bridge-grid">
          <h2>A simpler view of a sophisticated process.</h2>
          <div>
            <p>
              Planet’s Tanager-1 has the spectral resolution to uncover
              methane’s subtle fingerprint. Planet combines sophisticated
              detection algorithms with wind information to trace a plume
              towards its likely source.
            </p>
            <p>
              This demonstration focuses on the underlying principle. It
              removes the expected spectral background, then highlights the
              places where the satellite image most closely resembles
              methane’s known absorption fingerprint.
            </p>
          </div>
        </div>
      </section>

      <section className="map-heading">
        <h2>Explore an example plume</h2>
        <p>
          Tanager-1 captured signs of methane over a gas processing plant in
          Punjab, Pakistan.
        </p>
      </section>

      <section className="map-stage" onMouseLeave={clearReading}>
        <Map
          initialViewState={{
            longitude: footprintCenter[0],
            latitude: footprintCenter[1],
            zoom: 10.6,
          }}
          mapStyle={MAP_STYLE}
          style={{ width: "100%", height: "100%" }}
          onMouseMove={handleMove}
          cursor="crosshair"
          minZoom={9.2}
          maxZoom={12.2}
          dragPan
          dragRotate={false}
          scrollZoom
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
                  "line-color": "#4f392d",
                  "line-width": 1.25,
                  "line-opacity": 0.62,
                  "line-dasharray": [2, 2.5],
                }}
              />
            </Source>
          )}
        </Map>

        <div className="signal-legend" aria-label="Methane-like signal legend">
          <div className="legend-title">
            <span>Methane-like signal</span>
            <span>relative strength</span>
          </div>
          <div className="continuous-scale">
            <i className="scale-marker marker-insufficient" />
            <i className="scale-marker marker-weak" />
            <i className="scale-marker marker-medium" />
            <i className="scale-marker marker-strong" />
          </div>
          <div className="category-labels">
            <span>Insufficient</span>
            <span>Weak</span>
            <span>Medium</span>
            <span>Strong</span>
          </div>
        </div>

        {!reading && (
          <div className="hover-hint">
            <span className="crosshair-icon">＋</span>
            Hover the plume to inspect its spectral signature
          </div>
        )}
        {reading && <SpectralTooltip reading={reading} metadata={metadata} />}
      </section>

      <footer className="footnote">
        <p>
          The score measures resemblance to methane after removing the expected
          spectrum of similar surfaces. It indicates spectral evidence—not methane concentration.
        </p>
        <span>2102–2449 nm · 5 × 5 pixel regions</span>
      </footer>
    </main>
  );
}
