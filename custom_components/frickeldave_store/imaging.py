"""Bildverarbeitung für Uploads und Bestandsbilder (Issue #289).

Regeln (siehe ``.squad/decisions/inbox/bruce-289-bildoptimierung.md``):

* Lange Kante höchstens :data:`MAX_LONG_EDGE` Pixel – niemals hochskalieren.
* JPEG wird mit Qualität :data:`JPEG_QUALITY` progressiv neu geschrieben,
  EXIF und weitere Metadaten werden entfernt.
* PNG/WebP mit Transparenz werden zu WebP (:data:`WEBP_QUALITY`), ohne
  Transparenz zu JPEG.
* GIF und animierte WebP bleiben unverändert.
* Bilder, die bereits passen (lange Kante ≤ 1600 px **und** ≤ der
  konfigurierten Byte-Grenze, Standard 500 KiB), werden byteweise übernommen –
  kein Re-Encoding, kein Qualitätsverlust.

Pillow ist Core-Abhängigkeit von Home Assistant und wird deshalb **nicht** in
``manifest.json`` eingetragen. Der Import erfolgt bewusst erst bei Bedarf:
fehlt Pillow, scheitert der Upload mit einer deutschen Meldung statt mit einem
``ImportError`` beim Setup der Integration.

Die Metadaten der vorhandenen Bilder (Bytes, Maße, Inhaltstyp) werden beim
Lesen aus den Dateien ermittelt und prozesslokal gecacht. Der Cache ist nach
Pfad, ``mtime`` und Größe geschlüsselt, damit geänderte Dateien automatisch neu
gelesen werden, und durch :data:`METADATA_CACHE_SIZE` begrenzt, damit er bei
großen Katalogen nicht unbegrenzt wächst.

Seit Issue #322 lassen sich vorhandene Bilder um 90° drehen
(:func:`rotate_image_sync`). Gedreht wird immer auf Basis der **sichtbaren**
Ausrichtung (``ImageOps.exif_transpose`` zuerst), das Format und die
Dateiendung bleiben erhalten. Animierte GIF- und WebP-Dateien werden
abgelehnt, weil eine Drehung einzelne Frames unbrauchbar machen würde.
"""

from __future__ import annotations

import asyncio
import io
import threading
import warnings
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from .models import ImageSizeDict, ValidationError

#: Lange Kante des Ergebnisses in Pixeln.
MAX_LONG_EDGE: Final = 1600
#: Standardgrenze, ab der ein Bild als "zu groß" gilt (500 KiB).
#: Der effektive Wert kommt aus den Store-Einstellungen (``images.max_bytes``).
MAX_IMAGE_BYTES: Final = 500 * 1024
JPEG_QUALITY: Final = 82
WEBP_QUALITY: Final = 85
#: Schutz vor Dekomprimierungsbomben: 40 Megapixel reichen für jede Handykamera,
#: ein 10-MB-PNG könnte sonst mehrere Gigabyte Arbeitsspeicher belegen.
MAX_IMAGE_PIXELS: Final = 40_000_000
#: Obergrenze des Metadaten-Caches (Anzahl Dateien).
METADATA_CACHE_SIZE: Final = 4096

#: Drehrichtungen der Bilddrehung (Issue #322).
ROTATE_LEFT: Final = "left"
ROTATE_RIGHT: Final = "right"
ROTATE_DIRECTIONS: Final[tuple[str, ...]] = (ROTATE_LEFT, ROTATE_RIGHT)
#: Gradzahl je Richtung; negativ = gegen den Uhrzeigersinn.
ROTATE_DEGREES: Final[dict[str, int]] = {ROTATE_LEFT: -90, ROTATE_RIGHT: 90}
ROTATE_DIRECTION_MESSAGE: Final = "direction muss 'left' oder 'right' sein."
ANIMATED_ROTATE_MESSAGE: Final = (
    "Animierte GIF- und WebP-Bilder können nicht gedreht werden. Die Datei bleibt unverändert."
)

CONTENT_TYPE_BY_IMAGE_FORMAT: Final[dict[str, str]] = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "WEBP": "image/webp",
    "GIF": "image/gif",
}

CONTENT_TYPE_BY_SUFFIX: Final[dict[str, str]] = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

SUFFIX_BY_CONTENT_TYPE: Final[dict[str, str]] = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

_MISSING_PILLOW: Final = (
    "Bildverarbeitung nicht verfügbar: Die Python-Bibliothek Pillow fehlt. "
    "Pillow gehört zu den Home-Assistant-Core-Abhängigkeiten – bitte die "
    "Installation prüfen und Home Assistant neu starten."
)


def pillow() -> Any:
    """Pillow bei Bedarf importieren (kein Import auf Modulebene)."""

    try:
        from PIL import Image  # noqa: PLC0415 - absichtlich lazy
    except ImportError as err:  # pragma: no cover - Pillow ist Core-Abhängigkeit
        raise ValidationError(_MISSING_PILLOW, code="pillow_missing") from err
    return Image


def content_type_for_name(name: str) -> str:
    """Inhaltstyp aus der Dateiendung (Fallback ``application/octet-stream``)."""

    return CONTENT_TYPE_BY_SUFFIX.get(Path(name).suffix.casefold(), "application/octet-stream")


def suffix_for_content_type(content_type: str) -> str:
    """Dateiendung zu einem Inhaltstyp (Fallback ``.jpg``)."""

    return SUFFIX_BY_CONTENT_TYPE.get(content_type.casefold(), ".jpg")


def is_oversized(
    width: int | None,
    height: int | None,
    size: int,
    max_bytes: int = MAX_IMAGE_BYTES,
) -> bool:
    """Zu groß = lange Kante über 1600 px **oder** mehr als ``max_bytes``."""

    if size > max_bytes:
        return True
    longest = max(width or 0, height or 0)
    return longest > MAX_LONG_EDGE


def format_bytes(count: int) -> str:
    """Deutsche Kurzform: ``12,0 MB``, ``278 KB``, ``900 Bytes``."""

    if count >= 1024 * 1024:
        return f"{count / (1024 * 1024):.1f} MB".replace(".", ",")
    if count >= 1024:
        return f"{round(count / 1024)} KB"
    return f"{count} Byte" if count == 1 else f"{count} Bytes"


@dataclass(frozen=True, slots=True)
class ImageInfo:
    """Größenmetadaten einer Bilddatei (nicht im Store persistiert)."""

    bytes: int
    width: int | None
    height: int | None
    content_type: str
    oversized: bool
    mtime_ns: int | None = None
    animated: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "bytes": self.bytes,
            "width": self.width,
            "height": self.height,
            "content_type": self.content_type,
            "oversized": self.oversized,
            "mtime_ns": self.mtime_ns,
            "animated": self.animated,
        }


@dataclass(frozen=True, slots=True)
class OptimizeResult:
    """Ergebnis der Verkleinerung inklusive Metadaten vorher/nachher."""

    data: bytes
    content_type: str
    suffix: str
    width: int
    height: int
    original_bytes: int
    original_width: int
    original_height: int
    original_content_type: str
    resized: bool
    message: str

    def original_payload(self) -> dict[str, Any]:
        return {
            "bytes": self.original_bytes,
            "width": self.original_width,
            "height": self.original_height,
            "content_type": self.original_content_type,
        }

    def stored_payload(self) -> dict[str, Any]:
        return {
            "bytes": len(self.data),
            "width": self.width,
            "height": self.height,
            "content_type": self.content_type,
        }


@dataclass(frozen=True, slots=True)
class RotateResult:
    """Ergebnis einer 90°-Drehung inklusive Maßen vorher/nachher (Issue #322)."""

    data: bytes
    content_type: str
    direction: str
    degrees: int
    width: int
    height: int
    original_bytes: int
    original_width: int
    original_height: int
    original_content_type: str
    original_oversized: bool
    oversized: bool
    downscaled: bool
    message: str

    def before_payload(self) -> ImageSizeDict:
        return {
            "bytes": self.original_bytes,
            "width": self.original_width,
            "height": self.original_height,
            "content_type": self.original_content_type,
            "oversized": self.original_oversized,
        }

    def after_payload(self) -> ImageSizeDict:
        return {
            "bytes": len(self.data),
            "width": self.width,
            "height": self.height,
            "content_type": self.content_type,
            "oversized": self.oversized,
        }


def _invalid(reason: str) -> ValidationError:
    return ValidationError(
        f"Das Bild konnte nicht verarbeitet werden: {reason}",
        code="image_invalid",
    )


def _has_alpha(image: Any) -> bool:
    if image.mode in {"RGBA", "LA", "PA"}:
        return True
    if image.mode == "P":
        return "transparency" in image.info
    return bool(image.info.get("transparency"))


def _save(image: Any, target_format: str) -> bytes:
    """Neu kodieren, ohne EXIF/ICC/XMP zu übernehmen."""

    image.info.clear()
    buffer = io.BytesIO()
    if target_format == "WEBP":
        image.save(buffer, format="WEBP", quality=WEBP_QUALITY, method=4)
    else:
        image.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
    return buffer.getvalue()


def optimize_image_sync(
    data: bytes,
    content_type: str,
    max_bytes: int = MAX_IMAGE_BYTES,
) -> OptimizeResult:
    """Rohbytes synchron verkleinern; Aufruf gehört in einen Executor."""

    image_mod = pillow()
    original_content_type = (content_type or "").casefold()
    if original_content_type == "image/jpg":
        original_content_type = "image/jpeg"
    original_bytes = len(data)
    if not data:
        raise _invalid("Die Datei ist leer.")

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", image_mod.DecompressionBombWarning)
            with image_mod.open(io.BytesIO(data)) as source:
                width, height = source.size
                if width * height > MAX_IMAGE_PIXELS:
                    raise _invalid(
                        f"Das Bild ist mit {width}×{height} Pixeln zu groß "
                        f"(Grenze: {MAX_IMAGE_PIXELS // 1_000_000} Megapixel)."
                    )
                image_format = (source.format or "").upper()
                animated = bool(getattr(source, "is_animated", False)) or (
                    int(getattr(source, "n_frames", 1) or 1) > 1
                )
                has_alpha = _has_alpha(source)
                source.load()
                unchanged = _unchanged_result(
                    data=data,
                    content_type=original_content_type,
                    image_format=image_format,
                    animated=animated,
                    width=width,
                    height=height,
                    original_bytes=original_bytes,
                    max_bytes=max_bytes,
                )
                if unchanged is not None:
                    return unchanged

                target_format, target_type = _target_format(image_format, has_alpha)
                image = source.copy()
                image.thumbnail((MAX_LONG_EDGE, MAX_LONG_EDGE), image_mod.Resampling.LANCZOS)
                if target_format == "JPEG" and image.mode != "RGB":
                    image = image.convert("RGB")
                elif target_format == "WEBP" and image.mode not in {"RGB", "RGBA"}:
                    image = image.convert("RGBA" if has_alpha else "RGB")
                result = _save(image, target_format)
                new_width, new_height = image.size
    except ValidationError:
        raise
    except (image_mod.DecompressionBombError, image_mod.DecompressionBombWarning) as err:
        raise _invalid(f"Das Bild überschreitet die zulässige Pixelmenge ({err}).") from err
    except (
        image_mod.UnidentifiedImageError,
        OSError,
        ValueError,
        SyntaxError,
        KeyError,
        EOFError,
    ) as err:
        raise _invalid("Die Datei ist kein lesbares Bild oder beschädigt.") from err

    if result == data:
        # Re-Encoding ohne Byte-Änderung (deterministisch, bereits optimal):
        # als unverändert melden, damit wiederholte Läufe idempotent bleiben.
        return _passthrough(
            data,
            content_type=original_content_type or target_type,
            suffix=suffix_for_content_type(original_content_type or target_type),
            width=width,
            height=height,
            original_bytes=original_bytes,
            message=(
                f"Bild unverändert übernommen ({width}×{height}, {format_bytes(original_bytes)})."
            ),
        )
    message = (
        f"Bild von {format_bytes(original_bytes)} auf {format_bytes(len(result))} "
        f"verkleinert ({width}×{height} → {new_width}×{new_height})."
    )
    return OptimizeResult(
        data=result,
        content_type=target_type,
        suffix=suffix_for_content_type(target_type),
        width=new_width,
        height=new_height,
        original_bytes=original_bytes,
        original_width=width,
        original_height=height,
        original_content_type=original_content_type or target_type,
        resized=True,
        message=message,
    )


def _unchanged_result(
    *,
    data: bytes,
    content_type: str,
    image_format: str,
    animated: bool,
    width: int,
    height: int,
    original_bytes: int,
    max_bytes: int = MAX_IMAGE_BYTES,
) -> OptimizeResult | None:
    """Durchreichen, wenn das Format unangetastet bleiben muss oder bereits passt."""

    reason: str | None = None
    if image_format == "GIF":
        reason = "GIF"
    elif animated and image_format == "WEBP":
        reason = "Animiertes WebP"
    if reason is not None:
        return _passthrough(
            data,
            content_type=content_type,
            suffix=f".{image_format.lower()}",
            width=width,
            height=height,
            original_bytes=original_bytes,
            message=(
                f"{reason} unverändert übernommen "
                f"({width}×{height}, {format_bytes(original_bytes)})."
            ),
        )
    if is_oversized(width, height, original_bytes, max_bytes):
        return None
    return _passthrough(
        data,
        content_type=content_type,
        suffix=SUFFIX_BY_CONTENT_TYPE.get(content_type, ".jpg"),
        width=width,
        height=height,
        original_bytes=original_bytes,
        message=(
            f"Bild unverändert übernommen ({width}×{height}, {format_bytes(original_bytes)})."
        ),
    )


def _passthrough(
    data: bytes,
    *,
    content_type: str,
    suffix: str,
    width: int,
    height: int,
    original_bytes: int,
    message: str,
) -> OptimizeResult:
    return OptimizeResult(
        data=data,
        content_type=content_type,
        suffix=suffix,
        width=width,
        height=height,
        original_bytes=original_bytes,
        original_width=width,
        original_height=height,
        original_content_type=content_type,
        resized=False,
        message=message,
    )


def _target_format(image_format: str, has_alpha: bool) -> tuple[str, str]:
    """Zielformat: Transparenz → WebP, sonst JPEG."""

    if has_alpha:
        return "WEBP", "image/webp"
    return "JPEG", "image/jpeg"


async def async_optimize_image(
    data: bytes,
    content_type: str,
    max_bytes: int = MAX_IMAGE_BYTES,
) -> OptimizeResult:
    """Verkleinerung im Executor, damit der Event-Loop frei bleibt."""

    return await asyncio.to_thread(optimize_image_sync, data, content_type, max_bytes)


def _pillow_imageops() -> Any:
    """``ImageOps`` bei Bedarf importieren (``exif_transpose``)."""

    try:
        from PIL import ImageOps  # noqa: PLC0415 - absichtlich lazy
    except ImportError as err:  # pragma: no cover - Pillow ist Core-Abhängigkeit
        raise ValidationError(_MISSING_PILLOW, code="pillow_missing") from err
    return ImageOps


def _encode_rotated(image: Any, image_format: str, transparency: Any) -> bytes:
    """Gedrehtes Bild im Ausgangsformat kodieren; EXIF/ICC werden verworfen."""

    image_mod = pillow()
    has_alpha = _has_alpha(image)
    buffer = io.BytesIO()
    image.info.clear()
    if image_format == "JPEG":
        target = image if image.mode in {"RGB", "L"} else image.convert("RGB")
        target.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
    elif image_format == "WEBP":
        if image.mode not in {"RGB", "RGBA"}:
            image = image.convert("RGBA" if has_alpha else "RGB")
        image.save(buffer, format="WEBP", quality=WEBP_QUALITY, method=4)
    elif image_format == "PNG":
        # Palettenbilder verlieren ihre Transparenz beim Neukodieren nicht:
        # vorher nach RGBA (mit Alpha) bzw. RGB (ohne) wandeln.
        if image.mode not in {"RGB", "RGBA", "L", "LA", "1"}:
            image = image.convert("RGBA" if has_alpha else "RGB")
        image.save(buffer, format="PNG", optimize=True)
    else:  # GIF: statisch, Ausgangsformat bleibt GIF
        target = (
            image
            if image.mode in {"P", "L", "1"}
            else image.convert("P", palette=image_mod.Palette.ADAPTIVE)
        )
        if transparency is not None and target.mode == "P":
            target.save(buffer, format="GIF", transparency=transparency)
        else:
            target.save(buffer, format="GIF")
    return buffer.getvalue()


def rotate_image_sync(
    data: bytes,
    *,
    direction: str,
    content_type: str,
    max_bytes: int = MAX_IMAGE_BYTES,
) -> RotateResult:
    """Rohbytes synchron um 90° drehen; Aufruf gehört in einen Executor.

    Gedreht wird auf Basis der sichtbaren Ausrichtung (EXIF-Orientierung wird
    zuerst angewendet). Das Format bleibt erhalten; übergroße Altbestände
    (lange Kante > 1600 px) werden auf 1600 px verkleinert, nie vergrößert.
    PNG und statisches GIF bleiben verlustfrei; JPEG (Qualität 82) und WebP
    (Qualität 85) werden neu kodiert – dokumentierte Toleranz nach zwei
    Drehungen: mittlere Abweichung ≤ 2/255 je Farbkanal.
    """

    if direction not in ROTATE_DIRECTIONS:
        raise ValidationError(ROTATE_DIRECTION_MESSAGE, code="validation_error")
    image_mod = pillow()
    image_ops = _pillow_imageops()
    requested_type = (content_type or "").casefold()
    if requested_type == "image/jpg":
        requested_type = "image/jpeg"
    original_bytes = len(data)
    if not data:
        raise _invalid("Die Datei ist leer.")

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", image_mod.DecompressionBombWarning)
            with image_mod.open(io.BytesIO(data)) as source:
                width, height = source.size
                if width * height > MAX_IMAGE_PIXELS:
                    raise _invalid(
                        f"Das Bild ist mit {width}×{height} Pixeln zu groß "
                        f"(Grenze: {MAX_IMAGE_PIXELS // 1_000_000} Megapixel)."
                    )
                image_format = (source.format or "").upper()
                animated = bool(getattr(source, "is_animated", False)) or (
                    int(getattr(source, "n_frames", 1) or 1) > 1
                )
                if animated and image_format in {"GIF", "WEBP"}:
                    raise ValidationError(ANIMATED_ROTATE_MESSAGE, code="image_animated")
                if image_format not in CONTENT_TYPE_BY_IMAGE_FORMAT:
                    raise _invalid("Die Datei ist kein lesbares Bild oder beschädigt.")
                source.load()
                # Sichtbare Ausrichtung ist die Basis der Drehung (Issue #322).
                visible = image_ops.exif_transpose(source)
                transparency = (visible.info or {}).get("transparency")
                original_width, original_height = visible.size
                transpose = (
                    image_mod.Transpose.ROTATE_270
                    if direction == ROTATE_RIGHT
                    else image_mod.Transpose.ROTATE_90
                )
                rotated = visible.transpose(transpose)
                downscaled = False
                if max(rotated.size) > MAX_LONG_EDGE:
                    if rotated.mode == "P":
                        rotated = rotated.convert("RGBA" if transparency is not None else "RGB")
                    rotated.thumbnail((MAX_LONG_EDGE, MAX_LONG_EDGE), image_mod.Resampling.LANCZOS)
                    downscaled = True
                encoded = _encode_rotated(rotated, image_format, transparency)
                new_width, new_height = rotated.size
    except ValidationError:
        raise
    except (image_mod.DecompressionBombError, image_mod.DecompressionBombWarning) as err:
        raise _invalid(f"Das Bild überschreitet die zulässige Pixelmenge ({err}).") from err
    except (
        image_mod.UnidentifiedImageError,
        OSError,
        ValueError,
        SyntaxError,
        KeyError,
        EOFError,
    ) as err:
        raise _invalid("Die Datei ist kein lesbares Bild oder beschädigt.") from err

    format_type = CONTENT_TYPE_BY_IMAGE_FORMAT[image_format]
    result_type = (
        requested_type if requested_type in CONTENT_TYPE_BY_IMAGE_FORMAT.values() else format_type
    )
    label = "im Uhrzeigersinn" if direction == ROTATE_RIGHT else "gegen den Uhrzeigersinn"
    message = (
        f"Bild um 90° {label} gedreht "
        f"({original_width}×{original_height} → {new_width}×{new_height})."
    )
    return RotateResult(
        data=encoded,
        content_type=result_type,
        direction=direction,
        degrees=ROTATE_DEGREES[direction],
        width=new_width,
        height=new_height,
        original_bytes=original_bytes,
        original_width=original_width,
        original_height=original_height,
        original_content_type=result_type,
        original_oversized=is_oversized(original_width, original_height, original_bytes, max_bytes),
        oversized=is_oversized(new_width, new_height, len(encoded), max_bytes),
        downscaled=downscaled,
        message=message,
    )


async def async_rotate_image(
    data: bytes,
    *,
    direction: str,
    content_type: str,
    max_bytes: int = MAX_IMAGE_BYTES,
) -> RotateResult:
    """90°-Drehung im Executor, damit der Event-Loop frei bleibt."""

    return await asyncio.to_thread(
        rotate_image_sync,
        data,
        direction=direction,
        content_type=content_type,
        max_bytes=max_bytes,
    )


def read_info_sync(path: Path, max_bytes: int = MAX_IMAGE_BYTES) -> ImageInfo:
    """Metadaten einer Datei lesen (nur Header, kein vollständiges Dekodieren)."""

    content_type = CONTENT_TYPE_BY_SUFFIX.get(path.suffix.casefold(), "application/octet-stream")
    try:
        stat = path.stat()
    except OSError:
        return ImageInfo(
            bytes=0,
            width=None,
            height=None,
            content_type=content_type,
            oversized=False,
            mtime_ns=None,
            animated=False,
        )
    size = stat.st_size
    width: int | None = None
    height: int | None = None
    animated = False
    try:
        image_mod = pillow()
        with image_mod.open(path) as source:
            width, height = source.size
            animated = bool(getattr(source, "is_animated", False)) or (
                int(getattr(source, "n_frames", 1) or 1) > 1
            )
    except Exception:  # noqa: BLE001 - defekte Dateien (oder fehlendes Pillow) brechen die Liste nicht
        width = None
        height = None
        animated = False
    return ImageInfo(
        bytes=size,
        width=width,
        height=height,
        content_type=content_type,
        oversized=is_oversized(width, height, size, max_bytes),
        mtime_ns=stat.st_mtime_ns,
        animated=animated,
    )


class MetadataCache:
    """Kleiner LRU-Cache für Bildmetadaten (prozesslokal, threadsicher)."""

    def __init__(self, max_entries: int = METADATA_CACHE_SIZE) -> None:
        self._max_entries = max_entries
        self._entries: OrderedDict[tuple[str, int, int, int], ImageInfo] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: tuple[str, int, int, int]) -> ImageInfo | None:
        with self._lock:
            info = self._entries.get(key)
            if info is not None:
                self._entries.move_to_end(key)
            return info

    def put(self, key: tuple[str, int, int, int], info: ImageInfo) -> None:
        with self._lock:
            self._entries[key] = info
            self._entries.move_to_end(key)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def invalidate(self, path: Path | str) -> None:
        """Alle Einträge einer Datei verwerfen (z. B. nach dem Überschreiben)."""

        prefix = str(path)
        with self._lock:
            for key in [key for key in self._entries if key[0] == prefix]:
                del self._entries[key]

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


_CACHE: Final = MetadataCache()


def metadata_cache() -> MetadataCache:
    """Aktiver Cache (Tests können ihn leeren)."""

    return _CACHE


def inspect_sync(path: Path, max_bytes: int = MAX_IMAGE_BYTES) -> ImageInfo:
    """Metadaten mit Cache lesen; Schlüssel ist Pfad + mtime + Größe + Grenze."""

    try:
        stat = path.stat()
    except OSError:
        return read_info_sync(path, max_bytes)
    key = (str(path), stat.st_mtime_ns, stat.st_size, max_bytes)
    cached = _CACHE.get(key)
    if cached is not None:
        return cached
    info = read_info_sync(path, max_bytes)
    _CACHE.put(key, info)
    return info


def inspect_paths(paths: list[Path], max_bytes: int = MAX_IMAGE_BYTES) -> list[ImageInfo]:
    """Mehrere Dateien in einem Durchgang prüfen (Executor-Aufruf)."""

    return [inspect_sync(path, max_bytes) for path in paths]


async def async_inspect_paths(
    paths: list[Path], max_bytes: int = MAX_IMAGE_BYTES
) -> list[ImageInfo]:
    """``inspect_paths`` im Executor ausführen."""

    if not paths:
        return []
    return await asyncio.to_thread(inspect_paths, paths, max_bytes)


__all__ = [
    "ANIMATED_ROTATE_MESSAGE",
    "CONTENT_TYPE_BY_SUFFIX",
    "JPEG_QUALITY",
    "MAX_IMAGE_BYTES",
    "MAX_IMAGE_PIXELS",
    "MAX_LONG_EDGE",
    "METADATA_CACHE_SIZE",
    "ROTATE_DEGREES",
    "ROTATE_DIRECTIONS",
    "ROTATE_DIRECTION_MESSAGE",
    "ROTATE_LEFT",
    "ROTATE_RIGHT",
    "WEBP_QUALITY",
    "ImageInfo",
    "MetadataCache",
    "OptimizeResult",
    "RotateResult",
    "async_inspect_paths",
    "async_optimize_image",
    "async_rotate_image",
    "content_type_for_name",
    "format_bytes",
    "inspect_paths",
    "inspect_sync",
    "is_oversized",
    "metadata_cache",
    "optimize_image_sync",
    "pillow",
    "read_info_sync",
    "rotate_image_sync",
    "suffix_for_content_type",
]
