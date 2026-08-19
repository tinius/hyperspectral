import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { eciToGeodetic, gstime, propagate, twoline2satrec } from "satellite.js";
import landOutlines from "./land-outlines.json";
import footprintWeek from "./tanager-footprints-week.json";

const TLE_LINE_1 = "1 60507U 24149AR  26201.98216352  .00000223  00000+0  67777-5 0  9990";
const TLE_LINE_2 = "2 60507  97.2316 296.0820 0001970 137.5704 222.5698 15.43878726108250";
const ANIMATION_START = new Date(footprintWeek.start);
const EARTH_RADIUS_KM = 6371;
const MEAN_MOTION_PER_DAY = 15.43947597;
const MAX_HOURS = 24 * 7;
// Delay between the globe entering the viewport and the animation starting.
const AUTOPLAY_DELAY_MS = 1500;
const INITIAL_VIEW_LATITUDE = 30;

function earthPosition(longitude: number, latitude: number, radius: number) {
  const cosLatitude = Math.cos(latitude);
  return new THREE.Vector3(
    radius * cosLatitude * Math.cos(longitude),
    radius * Math.sin(latitude),
    -radius * cosLatitude * Math.sin(longitude),
  );
}

function positionAt(satrec: ReturnType<typeof twoline2satrec>, date: Date) {
  const propagated = propagate(satrec, date);
  if (!propagated || !propagated.position || typeof propagated.position === "boolean") return null;
  const geodetic = eciToGeodetic(propagated.position, gstime(date));
  return {
    ground: earthPosition(geodetic.longitude, geodetic.latitude, 1.006),
    satellite: earthPosition(
      geodetic.longitude,
      geodetic.latitude,
      1 + geodetic.height / EARTH_RADIUS_KM,
    ),
  };
}

function graticuleMaterial() {
  return new THREE.LineBasicMaterial({ color: 0xb6c8c1, transparent: true, opacity: 0.18 });
}

function createEarthTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 2048;
  canvas.height = 1024;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#123f5c";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(255, 255, 255, .27)";
  for (const ring of landOutlines as number[][][]) {
    if (ring.length < 3) continue;
    context.beginPath();
    for (let index = 0; index < ring.length; index += 1) {
      const point = ring[index];
      const x = ((point[0] + 180) / 360) * canvas.width;
      const y = ((90 - point[1]) / 180) * canvas.height;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function addGraticules(group: THREE.Group) {
  for (let latitude = -60; latitude <= 60; latitude += 30) {
    const points: THREE.Vector3[] = [];
    for (let longitude = -180; longitude <= 180; longitude += 4) {
      points.push(earthPosition(
        THREE.MathUtils.degToRad(longitude),
        THREE.MathUtils.degToRad(latitude),
        1.003,
      ));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), graticuleMaterial()));
  }
  for (let longitude = -150; longitude < 180; longitude += 30) {
    const points: THREE.Vector3[] = [];
    for (let latitude = -90; latitude <= 90; latitude += 3) {
      points.push(earthPosition(
        THREE.MathUtils.degToRad(longitude),
        THREE.MathUtils.degToRad(latitude),
        1.003,
      ));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), graticuleMaterial()));
  }
}

function footprintPosition(coordinates: number[][], radius = 1.034) {
  const points = coordinates.slice(0, -1);
  const longitude = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const latitude = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  return earthPosition(
    THREE.MathUtils.degToRad(longitude),
    THREE.MathUtils.degToRad(latitude),
    radius,
  );
}

function footprintPositions(coordinates: number[][]) {
  const ring = coordinates.slice(0, -1);
  const positions: number[] = [];
  for (let index = 1; index < ring.length - 1; index += 1) {
    for (const point of [ring[0], ring[index], ring[index + 1]]) {
      const position = earthPosition(
        THREE.MathUtils.degToRad(point[0]),
        THREE.MathUtils.degToRad(point[1]),
        1.034,
      );
      positions.push(position.x, position.y, position.z);
    }
  }
  return positions;
}

function footprintOutlinePositions(coordinates: number[][]) {
  const positions: number[] = [];
  for (let index = 1; index < coordinates.length; index += 1) {
    for (const point of [coordinates[index - 1], coordinates[index]]) {
      const position = earthPosition(
        THREE.MathUtils.degToRad(point[0]),
        THREE.MathUtils.degToRad(point[1]),
        1.037,
      );
      positions.push(position.x, position.y, position.z);
    }
  }
  return positions;
}

export default function OrbitGlobe() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef(0);
  const playingRef = useRef(false);
  const hasStartedRef = useRef(false);
  const replayRef = useRef<() => void>(() => undefined);
  const [elapsedHours, setElapsedHours] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const satrec = twoline2satrec(TLE_LINE_1, TLE_LINE_2);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(2.65, 1.45, 2.65);
    camera.lookAt(0, 0, 0);
    const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
    const screenRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const globe = new THREE.Group();
    const startingPosition = positionAt(satrec, ANIMATION_START);
    const initialQuaternion = new THREE.Quaternion();
    if (startingPosition) {
      const startingDirection = startingPosition.ground.clone().normalize();
      const horizontalDirection = new THREE.Vector3(
        startingDirection.x,
        0,
        startingDirection.z,
      ).normalize();
      const viewLatitude = THREE.MathUtils.degToRad(INITIAL_VIEW_LATITUDE);
      const localForward = new THREE.Vector3(
        horizontalDirection.x * Math.cos(viewLatitude),
        Math.sin(viewLatitude),
        horizontalDirection.z * Math.cos(viewLatitude),
      );
      const localNorth = new THREE.Vector3(0, 1, 0)
        .addScaledVector(localForward, -localForward.y)
        .normalize();
      const localRight = new THREE.Vector3().crossVectors(localNorth, localForward).normalize();
      const worldForward = camera.position.clone().normalize();
      const worldUp = camera.up.clone()
        .addScaledVector(worldForward, -camera.up.dot(worldForward))
        .normalize();
      const worldRight = new THREE.Vector3().crossVectors(worldUp, worldForward).normalize();
      const localBasis = new THREE.Matrix4().makeBasis(localRight, localNorth, localForward);
      const worldBasis = new THREE.Matrix4().makeBasis(worldRight, worldUp, worldForward);
      initialQuaternion.setFromRotationMatrix(
        worldBasis.multiply(localBasis.clone().transpose()),
      );
    }
    globe.quaternion.copy(initialQuaternion);
    scene.add(globe);
    const earthTexture = createEarthTexture();
    globe.add(new THREE.Mesh(
      new THREE.SphereGeometry(1, 128, 96),
      new THREE.MeshPhongMaterial({
        color: 0xffffff,
        map: earthTexture,
        shininess: 5,
      }),
    ));
    globe.add(new THREE.Mesh(
      new THREE.SphereGeometry(1.025, 128, 96),
      new THREE.MeshBasicMaterial({
        color: 0xa8c8dc,
        transparent: true,
        opacity: 0.055,
        side: THREE.BackSide,
      }),
    ));
    addGraticules(globe);

    const footprintMaterial = new THREE.MeshBasicMaterial({
      color: 0xedce5c,
      transparent: true,
      opacity: 0.62,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const footprintOutlineMaterial = new LineMaterial({
      color: 0xedce5c,
      linewidth: 4.5,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const allFootprintPositions: number[] = [];
    const allOutlinePositions: number[] = [];
    const captures = footprintWeek.scenes.map((capture) => {
      allFootprintPositions.push(...footprintPositions(capture.coordinates));
      allOutlinePositions.push(...footprintOutlinePositions(capture.coordinates));
      return {
        elapsedHours: (new Date(capture.datetime).getTime() - ANIMATION_START.getTime()) / 3_600_000,
        center: footprintPosition(capture.coordinates, 1.006),
        vertexCount: allFootprintPositions.length / 3,
        edgeCount: allOutlinePositions.length / 6,
      };
    });
    const footprintsGeometry = new THREE.BufferGeometry();
    footprintsGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(allFootprintPositions, 3),
    );
    footprintsGeometry.setDrawRange(0, 0);
    const footprints = new THREE.Mesh(footprintsGeometry, footprintMaterial);
    const footprintOutlinesGeometry = new LineSegmentsGeometry();
    footprintOutlinesGeometry.setPositions(allOutlinePositions);
    footprintOutlinesGeometry.instanceCount = 0;
    const footprintOutlines = new LineSegments2(
      footprintOutlinesGeometry,
      footprintOutlineMaterial,
    );
    globe.add(footprints, footprintOutlines);

    const trackPoints: THREE.Vector3[] = [];
    for (let minute = 0; minute <= MAX_HOURS * 60; minute += 1) {
      const position = positionAt(satrec, new Date(ANIMATION_START.getTime() + minute * 60_000));
      if (position) trackPoints.push(position.ground.clone().normalize().multiplyScalar(1.03));
    }
    const trackGeometry = new LineGeometry();
    trackGeometry.setPositions(trackPoints.flatMap((point) => [point.x, point.y, point.z]));
    trackGeometry.instanceCount = 0;
    const trackMaterial = new LineMaterial({ color: 0x71efc4, linewidth: 1 });
    const track = new Line2(trackGeometry, trackMaterial);
    track.computeLineDistances();
    globe.add(track);

    const satellite = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    const subpoint = new THREE.Mesh(
      new THREE.SphereGeometry(0.018, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x71efc4 }),
    );
    const tetherGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(), new THREE.Vector3(),
    ]);
    const tether = new THREE.Line(
      tetherGeometry,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.65 }),
    );
    globe.add(satellite, subpoint, tether);

    scene.add(new THREE.HemisphereLight(0xeaf5ff, 0x071521, 2.5));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(3, 2, 4);
    scene.add(sun);

    const resize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      renderer.setSize(width, height, false);
      trackMaterial.resolution.set(width, height);
      footprintOutlineMaterial.resolution.set(width, height);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    let autoplayTimer: ReturnType<typeof setTimeout> | undefined;
    const visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        if (hasStartedRef.current) return;
        if (entry.isIntersecting) {
          autoplayTimer = setTimeout(() => {
            if (hasStartedRef.current) return;
            hasStartedRef.current = true;
            playingRef.current = true;
            setPlaying(true);
            visibilityObserver.disconnect();
          }, AUTOPLAY_DELAY_MS);
        } else if (autoplayTimer) {
          clearTimeout(autoplayTimer);
          autoplayTimer = undefined;
        }
      },
      { threshold: 0.3 },
    );
    visibilityObserver.observe(mount);

    let dragging = false;
    let activePointer: number | null = null;
    let previousPointer = { x: 0, y: 0 };
    let resettingRotation = false;
    const canvas = renderer.domElement;
    const pointerDown = (event: PointerEvent) => {
      dragging = true;
      activePointer = event.pointerId;
      previousPointer = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = "grabbing";
    };
    const pointerMove = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== activePointer || resettingRotation) return;
      const deltaX = event.clientX - previousPointer.x;
      const deltaY = event.clientY - previousPointer.y;
      globe.quaternion.premultiply(
        new THREE.Quaternion().setFromAxisAngle(screenUp, deltaX * 0.006),
      );
      globe.quaternion.premultiply(
        new THREE.Quaternion().setFromAxisAngle(screenRight, deltaY * 0.006),
      );
      previousPointer = { x: event.clientX, y: event.clientY };
    };
    const pointerUp = (event: PointerEvent) => {
      if (event.pointerId !== activePointer) return;
      dragging = false;
      activePointer = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      canvas.style.cursor = "grab";
    };
    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerUp);

    replayRef.current = () => {
      progressRef.current = 0;
      setElapsedHours(0);
      setFinished(false);
      hasStartedRef.current = true;
      playingRef.current = false;
      setPlaying(true);
      resettingRotation = true;
    };

    let lastTime = performance.now();
    let lastLabelUpdate = 0;
    let frame = 0;
    const render = (now: number) => {
      const deltaSeconds = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      if (playingRef.current) {
        progressRef.current = Math.min(MAX_HOURS, progressRef.current + deltaSeconds * 4);
        if (progressRef.current >= MAX_HOURS) {
          playingRef.current = false;
          setPlaying(false);
          setFinished(true);
          setElapsedHours(MAX_HOURS);
        }
      }
      const date = new Date(ANIMATION_START.getTime() + progressRef.current * 3_600_000);
      const position = positionAt(satrec, date);
      if (position) {
        let target = position.ground;
        let visibleVertices = 0;
        let visibleEdges = 0;
        for (const capture of captures) {
          const hasHappened = capture.elapsedHours <= progressRef.current;
          if (hasHappened) {
            visibleVertices = capture.vertexCount;
            visibleEdges = capture.edgeCount;
          }
          if (
            capture.elapsedHours <= progressRef.current &&
            progressRef.current - capture.elapsedHours < 0.2
          ) target = capture.center;
        }
        footprintsGeometry.setDrawRange(0, visibleVertices);
        footprintOutlinesGeometry.instanceCount = visibleEdges;
        satellite.position.copy(position.satellite);
        subpoint.position.copy(target);
        const tetherPositions = tetherGeometry.attributes.position;
        tetherPositions.setXYZ(0, target.x, target.y, target.z);
        tetherPositions.setXYZ(1, position.satellite.x, position.satellite.y, position.satellite.z);
        tetherPositions.needsUpdate = true;
      }
      const revealedTrackPoints = Math.min(
        trackPoints.length,
        Math.max(1, Math.floor(progressRef.current * 60) + 1),
      );
      trackGeometry.instanceCount = Math.max(0, revealedTrackPoints - 1);
      if (resettingRotation) {
        const easing = 1 - Math.exp(-deltaSeconds * 5);
        globe.quaternion.slerp(initialQuaternion, easing);
        if (globe.quaternion.angleTo(initialQuaternion) < 0.002) {
          globe.quaternion.copy(initialQuaternion);
          resettingRotation = false;
          playingRef.current = true;
          lastTime = now;
        }
      } else if (playingRef.current && !dragging) {
        globe.quaternion.multiply(
          new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            deltaSeconds * 0.025,
          ),
        );
      }
      renderer.render(scene, camera);
      if (now - lastLabelUpdate > 90) {
        setElapsedHours(progressRef.current);
        lastLabelUpdate = now;
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      if (autoplayTimer) clearTimeout(autoplayTimer);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerUp);
      renderer.dispose();
      earthTexture?.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
          object.geometry.dispose();
          if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
          else object.material.dispose();
        }
      });
      renderer.domElement.remove();
    };
  }, []);

  const orbitCount = elapsedHours * MEAN_MOTION_PER_DAY / 24;
  const days = Math.floor(elapsedHours / 24);
  const hours = Math.floor(elapsedHours % 24);

  return (
    <div className="orbit-element">
      <div className="orbit-canvas" ref={mountRef} aria-label="Animated 3D orbit of Tanager-1 around Earth" />
      <div className="orbit-readout" aria-live="polite">
        <span><b>{days}d {hours}h</b> elapsed</span>
        <span><b>{orbitCount.toFixed(1)}</b> orbits</span>
      </div>
      <div className="orbit-key" aria-label="Orbit animation legend">
        <span><i className="orbit-key-track" />Orbit path</span>
        <span><i className="orbit-key-scene" />Captured scene</span>
      </div>
      <div className="orbit-controls">
        <button
          type="button"
          onClick={() => {
            if (finished) {
              replayRef.current();
              return;
            }
            hasStartedRef.current = true;
            playingRef.current = !playingRef.current;
            setPlaying(playingRef.current);
          }}
        >
          {finished ? "Replay" : playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min="0"
          max={MAX_HOURS}
          step="0.25"
          value={elapsedHours}
          aria-label="Elapsed time during the illustrated week"
          onChange={(event) => {
            const value = Number(event.target.value);
            progressRef.current = value;
            setElapsedHours(value);
            setFinished(value >= MAX_HOURS);
          }}
        />
        <span>7 days</span>
      </div>
    </div>
  );
}
