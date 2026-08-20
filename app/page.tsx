import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Map, {
  Layer,
  Marker,
  NavigationControl,
  Source,
  type MapLayerMouseEvent,
} from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import OrbitGlobe from "./OrbitGlobe";

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
  rawTarget: number[];
  curveMode: "percent_radiance_difference";
  referenceTargetDepthPercent: number;
  curveQuantizationScale: number;
  curveNoData: number;
  scoreByRegion: number[][];
  scoreNoData: number;
  retrievalWindowNm: [number, number];
};

type HoverReading = {
  x: number;
  y: number;
  mapHeight: number;
  score: number;
  curve: number[];
};

type TapLocation = {
  longitude: number;
  latitude: number;
};

type BandFrame = {
  file: string;
  bandIndex: number;
  wavelengthNm: number;
  region: string;
};

type BandSequence = {
  assetVersion: string;
  width: number;
  height: number;
  normalization: string;
  frames: BandFrame[];
};

type SourceHistoryData = {
  center: [number, number];
  widthKm: number;
  heightKm: number;
  basemap: string;
  plumes: Array<{
    id: string;
    date: string;
    emission: number;
    uncertainty: number;
    windSpeed: number;
    windDirectionTo: number;
    image: string;
  }>;
};

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;
const MAP_STYLE = `https://api.maptiler.com/maps/base-v4/style.json?key=${MAPTILER_KEY}`;
const assetUrl = (path: string) => `${import.meta.env.BASE_URL}${path}`;
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
  const rawTargetDepth = Math.abs(Math.min(...metadata.rawTarget));
  const fixedTarget = metadata.rawTarget.map(
    (value) =>
      (value / Math.max(rawTargetDepth, 1e-8))
      * metadata.referenceTargetDepthPercent,
  );
  // Use one fixed percentage scale. Extreme observed or fitted curves clip
  // rather than changing the apparent scale while hovering.
  const yMinimum = -25;
  const yMaximum = 8;
  const makeY = (value: number) => {
    const unclippedY =
      ((yMaximum - value) / (yMaximum - yMinimum)) * height;
    return Math.max(0, Math.min(height, unclippedY));
  };
  const makePath = (values: number[]) =>
    values.map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * width;
      const y = makeY(value);
      return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  const label =
    reading.score >= 7
      ? "Strong methane signal"
      : reading.score >= 2
        ? "Medium methane signal"
        : "No methane signal";
  const labelClass =
    reading.score >= 7
      ? "strong"
      : reading.score >= 2
        ? "medium"
        : "none";

  return (
    <aside
      className={`spectral-tooltip ${
        reading.y > reading.mapHeight / 2
          ? "mobile-tooltip-top"
          : "mobile-tooltip-bottom"
      }`}
      style={{
        left: `min(calc(100% - 338px), ${reading.x + 18}px)`,
        top: `min(calc(100% - 250px), ${reading.y + 18}px)`,
      }}
      aria-live="polite"
    >
      <div className="tooltip-heading">
        <div>
          <span className={`signal-dot signal-${labelClass}`} />
          <span style={{ fontWeight : reading.score >= 7 ? "bold" : "normal" }}>{label}</span>
        </div>
      </div>
      <svg
        className="spectral-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Observed background-adjusted spectrum compared with the methane target"
      >
        <line x1="0" x2={width} y1={makeY(0)} y2={makeY(0)} className="zero-line" />
        {/* <text x="0" y="20" className="y-direction-label">
          ↑ More absorption
        </text>
        <text x="0" y={height - 14} className="y-direction-label">
          ↓ Less absorption
        </text> */}
        <path d={makePath(fixedTarget)} className="target-line" />
        <path d={makePath(reading.curve)} className="observed-line" />
      </svg>
      <div className="axis-labels">
        <span>{Math.round(metadata.retrievalWindowNm[0])} nm</span>
        <span>{Math.round(metadata.retrievalWindowNm[1])} nm</span>
      </div>
      <div className="chart-legend">
        <span><i className="legend-line observed" />Observed here</span>
        <span><i className="legend-line target" />Methane absorption pattern</span>
      </div>
      <p>
        Observed light relative to similar surfaces. Methane pattern scaled to
        match the scene’s strongest detections.
      </p>
    </aside>
  );
}

function BandScrubber() {
  const [sequence, setSequence] = useState<BandSequence | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageCacheRef = useRef<globalThis.Map<number, HTMLImageElement>>(
    new globalThis.Map(),
  );
  const activeFrameRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    fetch(assetUrl("data/bands/bands.json"))
      .then((response) => response.json())
      .then((data: BandSequence) => {
        if (cancelled) return;
        setSequence(data);
        const nearInfrared = data.frames.findIndex(
          (frame) => frame.wavelengthNm >= 850,
        );
        setFrameIndex(Math.max(0, nearInfrared));
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    activeFrameRef.current = frameIndex;
    if (!sequence) return;

    const loadFrame = (index: number, drawWhenReady: boolean) => {
      if (index < 0 || index >= sequence.frames.length) return;
      const draw = (image: HTMLImageElement) => {
        if (!drawWhenReady || activeFrameRef.current !== index) return;
        const context = canvasRef.current?.getContext("2d");
        if (!context) return;
        context.fillStyle = "#000";
        context.fillRect(0, 0, sequence.width, sequence.height);
        context.drawImage(image, 0, 0, sequence.width, sequence.height);
      };
      const cached = imageCacheRef.current.get(index);
      if (cached?.complete) {
        draw(cached);
        return;
      }
      if (cached) {
        cached.addEventListener("load", () => draw(cached), { once: true });
        return;
      }
      const image = new Image();
      image.decoding = "async";
      image.onload = () => draw(image);
      image.src = `${assetUrl(`data/bands/${sequence.frames[index].file}`)}?v=${sequence.assetVersion}`;
      imageCacheRef.current.set(index, image);
    };

    loadFrame(frameIndex, true);
    for (let offset = 1; offset <= 3; offset += 1) {
      loadFrame(frameIndex - offset, false);
      loadFrame(frameIndex + offset, false);
    }
  }, [frameIndex, sequence]);

  const scrubFromPointer = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!sequence) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    setFrameIndex(Math.round(position * (sequence.frames.length - 1)));
  }, [sequence]);

  if (!sequence) {
    return <div className="band-loading">Preparing the spectral bands…</div>;
  }

  const frame = sequence.frames[frameIndex];
  return (
    <div className="band-viewer">
      <div className="band-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="band-canvas"
          width={sequence.width}
          height={sequence.height}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            scrubFromPointer(event);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              scrubFromPointer(event);
            }
          }}
          aria-label={`Tanager scene at ${Math.round(frame.wavelengthNm)} nanometres`}
        />
        <div className="band-readout">
          <strong>{Math.round(frame.wavelengthNm).toLocaleString()} nm</strong>
          <span>{frame.region}</span>
        </div>
        <span className="band-counter">Band {frame.bandIndex + 1} of 426</span>
      </div>
      <div className="band-controls">
        <input
          type="range"
          min="0"
          max={sequence.frames.length - 1}
          value={frameIndex}
          onChange={(event) => setFrameIndex(Number(event.target.value))}
          aria-label="Wavelength"
        />
        <div className="band-scale" aria-hidden="true">
          <span>400 nm</span>
          <span>Visible</span>
          <span>Near infrared</span>
          <span>Shortwave infrared</span>
          <span>2,450 nm</span>
        </div>
      </div>
      <p className="band-normalization-note">
        Each image is contrast-adjusted separately so that faint spatial detail
        remains visible across the spectrum. Low-signal bands dominated by
        atmospheric water absorption around 1,400 and 1,900 nm are omitted.
      </p>
    </div>
  );
}

function SourceHistory() {
  const [history, setHistory] = useState<SourceHistoryData | null>(null);

  useEffect(() => {
    fetch(assetUrl("data/source-history/history.json"))
      .then((response) => response.json())
      .then((data: SourceHistoryData) => setHistory(data));
  }, []);

  if (!history) return null;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <section className="source-history">
      <div className="source-history-heading">
        <h2>One source, seen again and again</h2>
        <p>
          Tanager repeatedly detected methane at this facility. A fixed view
          makes it possible to compare how the plume changes with the wind and
          the estimated emission rate.
        </p>
      </div>
      <div className="source-history-grid">
        {history.plumes.map((plume) => (
          <article className="history-card" key={plume.id}>
            <div className="history-map">
              <img
                className="history-basemap"
                src={assetUrl(`data/source-history/${history.basemap}`)}
                alt=""
              />
              <img
                className="history-plume"
                src={assetUrl(`data/source-history/${plume.image}`)}
                alt={`Methane enhancement detected on ${plume.date}`}
              />
              <header className="history-card-heading">
                <time dateTime={plume.date}>
                  {formatter.format(new Date(`${plume.date}T00:00:00Z`))}
                </time>
              </header>
              <div className="history-wind">
                <svg
                  className="history-wind-arrow"
                  style={{ transform: `rotate(${plume.windDirectionTo}deg)` }}
                  viewBox="0 0 18 30"
                  aria-hidden="true"
                >
                  <path className="wind-pointer" d="M9 1 17 29 9 22 1 29Z" />
                </svg>
                <span>{plume.windSpeed.toFixed(1)} m/s</span>
              </div>
            </div>
          </article>
        ))}
      </div>
      <p className="source-history-attribution">Satellite basemap © MapTiler</p>
    </section>
  );
}

export default function Home() {
  const [metadata, setMetadata] = useState<SceneMetadata | null>(null);
  const spectraRef = useRef<Int16Array | null>(null);
  const [reading, setReading] = useState<HoverReading | null>(null);
  const [tapLocation, setTapLocation] = useState<TapLocation | null>(null);
  const lastRegionRef = useRef<string | null>(null);
  const mapStageRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(assetUrl("data/methane-scene.json")).then((response) => response.json()),
      fetch(assetUrl("data/hover-spectra.i16")).then((response) => response.arrayBuffer()),
    ]).then(([scene, buffer]: [SceneMetadata, ArrayBuffer]) => {
      if (cancelled) return;
      spectraRef.current = new Int16Array(buffer);
      setMetadata(scene);
    });
    return () => { cancelled = true; };
  }, []);

  const updateReading = useCallback((
    event: MapLayerMouseEvent,
    markTap: boolean,
  ) => {
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
      if (markTap) setTapLocation(null);
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
    if (!markTap && lastRegionRef.current === regionKey) return;
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
      if (markTap) setTapLocation(null);
      return;
    }
    setReading({
      x: event.point.x,
      y: event.point.y,
      mapHeight: mapStageRef.current?.clientHeight ?? 0,
      score,
      curve: Array.from(encoded, (value) => value * metadata.curveQuantizationScale),
    });
    if (markTap) {
      setTapLocation({
        longitude: event.lngLat.lng,
        latitude: event.lngLat.lat,
      });
    }
  }, [metadata]);

  const handleMove = useCallback(
    (event: MapLayerMouseEvent) => updateReading(event, false),
    [updateReading],
  );

  const handleTap = useCallback(
    (event: MapLayerMouseEvent) => updateReading(event, true),
    [updateReading],
  );

  const clearReading = useCallback(() => {
    lastRegionRef.current = null;
    setReading(null);
  }, []);

  useEffect(() => {
    const clearOutsideMap = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !mapStageRef.current?.contains(target)) {
        lastRegionRef.current = null;
        setReading(null);
        setTapLocation(null);
      }
    };
    document.addEventListener("pointerdown", clearOutsideMap);
    return () => document.removeEventListener("pointerdown", clearOutsideMap);
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
              Most satellites looking at Earth capture only a few broad bands of light: familiar colours like blue,
              green and red as well as some regions outside of what our eyes can see, like near-infrared.</p>

              <p>
              Hyperspectral sensors, like the one aboard Planet’s Tanager-1, measure the incoming light in hundreds of narrow bands,
              unlocking new kinds of analysis. 
            </p>
            <p>
              One application is the detection of methane, a potent greenhouse gas invisible to the naked eye.
              Methane absorbs light at a series of very specific wavelengths,
              leaving a spectral “fingerprint” that can be recognised in the data captured by Tanager-1.
            </p>
          </div>
        </div>

        <div className="spectrum-explainer">
          <div className="spectrum-heading">
            <strong>The optical spectrum captured by Tanager-1</strong>
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
            <span style={{ left: "81%", transform : 'translate(-50%,7px)', color : '#5a3021', fontWeight: 'bold' }}>2,100</span>
            <span style={{ left: "97.6%", transform: 'translate(-50%, 7px)', color : '#5a3021', fontWeight: 'bold' }}>2,450</span>
          </div>
          <p className="spectrum-note">
            Methane absorbs light particularly strongly in the region between 2,100 and 2,450 nm.
          </p>
        </div>
      </section>

      <section className="method-bridge">
        <div className="method-bridge-grid">
          <h2>Matching methane’s spectral signature</h2>
          <div>
            <p>
            Planet and Carbon Mapper use sophisticated algorithms to estimate methane concentrations and emission rates
            from hyperspectral imagery. This demo illustrates the underlying idea with a simplified approach.
            </p>
            <p>
              After subtracting background noise,
              the algorithm looks at how closely a pixel resembles methane’s
              absorption fingerprint inside a key window of wavelengths.
            </p>
            <p>
              The map below demonstrates the algorithm on an example scene, revealing a large methane plume over a
              gas processing plant in Punjab, Pakistan.
            </p>
          </div>
        </div>
      </section>

      <section ref={mapStageRef} className="map-stage" onMouseLeave={clearReading}>
        <Map
          initialViewState={{
            longitude: 69.8,
            latitude: 27.993,
            zoom: 11.6,
          }}
          mapStyle={MAP_STYLE}
          style={{ width: "100%", height: "100%" }}
          onLoad={(event) => event.target.touchZoomRotate.disableRotation()}
          onMouseMove={handleMove}
          onClick={handleTap}
          cursor="crosshair"
          minZoom={10.2}
          maxZoom={12.8}
          dragPan
          dragRotate={false}
          scrollZoom={false}
          doubleClickZoom
          touchZoomRotate
          touchPitch={false}
          cooperativeGestures
          keyboard
        >
          <NavigationControl position="bottom-right" showCompass={false} />
          <Source id="basemap-wash" type="geojson" data={BASEMAP_WASH}>
            {/* <Layer
              id="basemap-wash-layer"
              type="fill"
              paint={{
                "fill-color": "#f3f0ea",
                "fill-opacity": 1,
              }}
            /> */}
          </Source>
          <Source
            id="tanager-visual"
            type="image"
            url={assetUrl("data/tanager-visual.png")}
            coordinates={metadata.corners}
          >
            <Layer
              id="tanager-visual-layer"
              type="raster"
              paint={{
                "raster-opacity": 0.5,
                "raster-resampling": "linear",
                "raster-fade-duration": 0,
              }}
            />
          </Source>
          <Source
            id="methane-score"
            type="image"
            url={assetUrl("data/methane-score.png")}
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
                  "line-width": 1.5,
                  "line-opacity": 0.9,
                  "line-dasharray": [1, 3],
                }}
              />
            </Source>
          )}
          {tapLocation && (
            <Marker
              longitude={tapLocation.longitude}
              latitude={tapLocation.latitude}
              anchor="center"
            >
              <span className="tap-marker" aria-hidden="true" />
            </Marker>
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
            <span className="desktop-hint">
              Hover inside the scene to inspect the spectral signature
            </span>
            <span className="mobile-hint">
              Tap inside the scene to inspect the spectral signature
            </span>
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

      <section className="orbit-section">
        <div className="orbit-section-heading">
          <h2>A week in the life</h2>
          <p>
           Tanager-1 is hurtling through space at around 17,000 miles per hour, completing one orbit around Earth every 93 minutes.
</p><p>
Over the course of a week, it observes hundreds of potential methane sources, from oil and gas facilities to landfills. By returning to the same sites over weeks and months, it can track how their emissions change over time.

          </p>
        </div>
        <OrbitGlobe />
        <p className="orbit-method-note">
          The tracks shown are based on the real <a href="https://keeptrack.space/satellite/60507" target="_blank">orbital parameters</a> of Tanager-1 and correspond to the week from July 12 to July 19, 2026. The yellow polygons show real scene footprints from Carbon Mapper’s methane collection for the same time period. The outlines of these polygons are slightly exaggerated for visibility.
        </p>
      </section>
    </main>
  );
}
