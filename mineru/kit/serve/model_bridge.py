# Copyright 2026 Kube AI Hub.
"""Bridge a model directory into the location MinerU's registry expects.

MinerU resolves its VLM weights through a fixed layout: every repo in
:mod:`mineru.model.registry` has a ``local_name``, and
:meth:`ModelRepo.local_dir` maps that to ``<model.base_dir>/<local_name>``.
A directory only counts as ready when it carries the
:data:`~mineru.model.download.MODEL_COMPLETE_MARKER` file, and
``get_vlm_predictor`` passes ``model_path=None``, so a local run calls
``ensure()`` and downloads when the layout is not already in place.

A serving deployment usually receives its weights from somewhere else - a
platform that mounts them, a read-only volume, a preloaded cache - so this
module points MinerU at that directory instead of downloading. It links the
incoming directory into the expected location and writes the marker there,
never inside the incoming directory itself, which may be read-only.
"""

from __future__ import annotations

import logging
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from ...config import config
from ...model.download import MODEL_COMPLETE_MARKER
from ...model.registry import MINERU_2_5_PRO_2605_1_2B

logger = logging.getLogger(__name__)

#: Environment variable naming the directory that already holds the weights.
MODEL_DIR_ENV = "MINERU_MODEL_DIR"

#: Where a serving platform mounts the model it downloaded.
DEFAULT_PLATFORM_MODEL_DIR = "/mnt/models/model"

#: Files that must exist for the directory to be treated as VLM weights rather
#: than an empty mount or a directory belonging to another model.
_REQUIRED_WEIGHT_FILES = ("config.json",)


class ModelBridgeError(RuntimeError):
    """The incoming directory cannot be used as the VLM weight directory."""


@dataclass(frozen=True)
class BridgeResult:
    """Outcome of :func:`bridge_vlm_weights`."""

    source: Path
    target: Path
    linked: bool
    """True when the weights were linked into place, False when already there."""


def _incoming_model_dir(explicit: str | Path | None = None) -> Path | None:
    """Resolve the directory holding the weights, or None when unset.

    An explicit argument wins, then ``MINERU_MODEL_DIR``, then the platform's
    mount point when it actually contains weights. Returning None lets the
    caller keep MinerU's normal download behaviour on a machine that has
    neither, which is what an interactive developer expects.
    """
    candidates: list[Path] = []
    if explicit is not None:
        candidates.append(Path(explicit).expanduser())
    else:
        configured = os.getenv(MODEL_DIR_ENV, "").strip()
        if configured:
            candidates.append(Path(configured).expanduser())
        else:
            candidates.append(Path(DEFAULT_PLATFORM_MODEL_DIR))

    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return None


def _has_weights(directory: Path) -> bool:
    """Report whether a directory looks like the model it is claimed to be.

    A mounted volume can be present but empty while the download is still in
    flight, and linking an empty directory would make MinerU report the model
    as ready and then fail deep inside inference.
    """
    return all((directory / name).is_file() for name in _REQUIRED_WEIGHT_FILES)


def _clear_target(target: Path) -> None:
    """Remove a previous link or stale directory at the target path."""
    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.is_dir():
        shutil.rmtree(target)


def _link_weights(source: Path, target: Path) -> None:
    """Expose source's contents at target without copying them.

    The target has to be a real directory holding a real marker file, because
    the marker must not be written into the source: a platform commonly mounts
    the weights read-only, and a symlinked directory would send the write
    straight through to it. So the directory is created here and each entry
    inside it is linked individually, which keeps the gigabytes un-copied.

    Symlinks are unavailable across filesystems, so a copy is the fallback
    rather than failing the deployment.
    """
    target.mkdir(parents=True, exist_ok=True)
    try:
        for entry in source.iterdir():
            (target / entry.name).symlink_to(entry)
        return
    except OSError as exc:
        logger.warning(
            "Cannot link the weights from %s into %s (%s); copying them instead.",
            source,
            target,
            exc,
        )
    _clear_target(target)
    shutil.copytree(source, target)


def bridge_vlm_weights(
    incoming: str | Path | None = None,
    *,
    required: bool = False,
) -> BridgeResult | None:
    """Point MinerU at preloaded VLM weights instead of downloading them.

    Args:
        incoming: Directory holding the weights. Defaults to
            ``MINERU_MODEL_DIR``, then the platform mount point.
        required: Raise :class:`ModelBridgeError` when no directory is
            available. Serving deployments set this so a missing mount fails
            fast with a clear message instead of downloading at startup.

    Returns:
        The bridge outcome, or None when no directory was configured and
        ``required`` is False.

    Raises:
        ModelBridgeError: When the directory is missing, empty, or cannot be
            linked into place and ``required`` is True.
    """
    source = _incoming_model_dir(incoming)
    if source is None:
        if required:
            raise ModelBridgeError(
                f"No model directory found. Set {MODEL_DIR_ENV} or mount the weights at "
                f"{DEFAULT_PLATFORM_MODEL_DIR}."
            )
        return None

    if not _has_weights(source):
        message = (
            f"{source} does not look like the VLM weights: "
            f"missing {', '.join(_REQUIRED_WEIGHT_FILES)}."
        )
        if required:
            raise ModelBridgeError(message)
        logger.warning("%s Leaving MinerU to resolve its own model.", message)
        return None

    target = _target_dir()

    # A previous bridge that already points at this same source needs nothing
    # more than the marker, which keeps a restart cheap.
    if target.is_dir() and (target / MODEL_COMPLETE_MARKER).is_file():
        marker = (target / MODEL_COMPLETE_MARKER).read_text(encoding="utf-8").strip()
        if marker == str(source.resolve()):
            return BridgeResult(source=source, target=target, linked=False)

    _clear_target(target)
    try:
        _link_weights(source, target)
    except OSError as exc:
        raise ModelBridgeError(f"Cannot link {source} to {target}: {exc}") from exc

    # The marker records which directory the weights came from, so a later run
    # against a different mount relinks instead of trusting a stale layout.
    (target / MODEL_COMPLETE_MARKER).write_text(str(source.resolve()) + "\n", encoding="utf-8")
    logger.info("Using preloaded VLM weights from %s via %s.", source, target)
    return BridgeResult(source=source, target=target, linked=True)


def _target_dir() -> Path:
    """Return where MinerU expects this model's weights.

    The registry owns this location: ``local_dir()`` is what
    ``MINERU_2_5_PRO_2605_1_2B.ensure()`` reads, so the bridge has to write
    there rather than anywhere more convenient. Kept as a function so a caller
    (or a test) can redirect it without rebuilding the config singleton, which
    is resolved once at import.
    """
    return MINERU_2_5_PRO_2605_1_2B.local_dir()


def weights_dir() -> Path:
    """Return the directory the readiness check should look at."""
    return _target_dir()


def model_base_dir() -> Path:
    """Return the directory MinerU treats as its model root."""
    return Path(config.model.base_dir).expanduser()


__all__ = [
    "DEFAULT_PLATFORM_MODEL_DIR",
    "MODEL_DIR_ENV",
    "BridgeResult",
    "ModelBridgeError",
    "bridge_vlm_weights",
    "model_base_dir",
    "weights_dir",
]
