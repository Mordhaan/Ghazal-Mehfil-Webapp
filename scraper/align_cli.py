#!/usr/bin/env python3
"""
align_cli.py — entry point that works no matter how Python was launched.

This machine runs Python with `PYTHONSAFEPATH`, so `python -m scraper.align.run`
does not put the repository on `sys.path`. This launcher does it explicitly and
keeps the documented command short:

    python scraper/align_cli.py --report
    python scraper/align_cli.py --track t0 --force
    python scraper/align_cli.py --all --model medium --device cuda
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scraper.align.run import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
