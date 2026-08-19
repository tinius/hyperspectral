#!/usr/bin/env python3
"""Export representative Tanager radiance bands for a browser scrubber.

Each band is independently stretched between robust percentiles. The result is
intended to reveal spatial structure as wavelength changes, not to compare
absolute brightness between wavelengths.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import h5py
import numpy as np
from PIL import Image


RADIANCE_PATH = "HDFEOS/GRIDS/HYP/Data Fields/toa_radiance"
ATMOSPHERIC_ABSORPTION_WINDOWS_NM = ((1350, 1480), (1780, 2000))


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("hdf5", type=Path, help="Tanager ortho-radiance HDF5")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--frames", type=int, default=64)
    parser.add_argument("--minimum-nm", type=float, default=400)
    parser.add_argument("--maximum-nm", type=float, default=2450)
    parser.add_argument("--width", type=int, default=640)
    return parser.parse_args()


def spectral_region(wavelength: float) -> str:
    if wavelength < 700:
        return "Visible light"
    if wavelength < 1400:
        return "Near infrared"
    return "Shortwave infrared"


def main() -> None:
    options = arguments()
    options.output_dir.mkdir(parents=True, exist_ok=True)

    with h5py.File(options.hdf5) as handle:
        radiance = handle[RADIANCE_PATH]
        wavelengths = np.asarray(radiance.attrs["wavelengths"], dtype=float)
        usable = (
            (wavelengths >= options.minimum_nm)
            & (wavelengths <= options.maximum_nm)
        )
        for minimum, maximum in ATMOSPHERIC_ABSORPTION_WINDOWS_NM:
            usable &= ~((wavelengths >= minimum) & (wavelengths <= maximum))
        usable_indices = np.flatnonzero(usable)
        indices = usable_indices[
            np.round(np.linspace(0, len(usable_indices) - 1, options.frames)).astype(int)
        ]
        fill_value = float(radiance.attrs.get("_FillValue", -9999.0))
        height, width = radiance.shape[1:]
        output_height = round(height * options.width / width)
        frames = []

        for frame_number, band_index in enumerate(indices):
            band = np.asarray(radiance[band_index], dtype=np.float32)
            valid = np.isfinite(band) & (band != fill_value) & (band > 0)
            if not np.any(valid):
                continue

            low, high = np.percentile(band[valid], [1.0, 99.0])
            if high <= low:
                continue
            grayscale = np.clip((band - low) / (high - low), 0, 1)
            grayscale = np.where(valid, grayscale, 0)
            pixels = np.round(grayscale * 255).astype(np.uint8)
            image = Image.fromarray(pixels).resize(
                (options.width, output_height), Image.Resampling.LANCZOS
            )
            filename = f"band-{frame_number:02d}.webp"
            image.save(options.output_dir / filename, "WEBP", quality=78, method=6)

            wavelength = float(wavelengths[band_index])
            frames.append({
                "file": filename,
                "bandIndex": int(band_index),
                "wavelengthNm": round(wavelength, 2),
                "region": spectral_region(wavelength),
                "stretch": [float(low), float(high)],
            })

    metadata = {
        "scene": options.hdf5.stem,
        "assetVersion": "atmospheric-windows-v1",
        "width": options.width,
        "height": output_height,
        "normalization": "Per-band 1st–99th percentile radiance stretch",
        "excludedAtmosphericWindowsNm": ATMOSPHERIC_ABSORPTION_WINDOWS_NM,
        "frames": frames,
    }
    (options.output_dir / "bands.json").write_text(
        json.dumps(metadata, indent=2) + "\n"
    )
    print(f"Exported {len(frames)} frames to {options.output_dir}")


if __name__ == "__main__":
    main()
