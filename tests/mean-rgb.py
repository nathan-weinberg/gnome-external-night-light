#!/usr/bin/env python3
"""Prints the mean R G B (0-255) of a PNG."""
import sys

from PIL import Image, ImageStat

img = Image.open(sys.argv[1]).convert("RGB")
print(" ".join(f"{c:.1f}" for c in ImageStat.Stat(img).mean))
