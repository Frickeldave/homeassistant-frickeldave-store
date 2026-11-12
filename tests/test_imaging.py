"""Tests für die Bildverkleinerung (:mod:`frickeldave_store.imaging`)."""

from __future__ import annotations

import builtins
import io

import pytest
from image_helpers import exif_bytes, gif_bytes, image_bytes, jpeg_bytes, png_bytes
from PIL import Image, ImageChops, ImageStat

from custom_components.frickeldave_store import imaging
from custom_components.frickeldave_store.imaging import (
    MAX_IMAGE_BYTES,
    MAX_LONG_EDGE,
    format_bytes,
    is_oversized,
    optimize_image_sync,
    rotate_image_sync,
)
from custom_components.frickeldave_store.models import ValidationError


def _open(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data))


def test_large_jpeg_is_scaled_to_max_long_edge() -> None:
    result = optimize_image_sync(jpeg_bytes((4032, 3024), quality=95), "image/jpeg")

    assert result.resized is True
    assert result.content_type == "image/jpeg"
    assert result.suffix == ".jpg"
    assert max(result.width, result.height) == MAX_LONG_EDGE
    assert (result.width, result.height) == (1600, 1200)
    assert (result.original_width, result.original_height) == (4032, 3024)
    assert len(result.data) < result.original_bytes
    assert "verkleinert" in result.message and "1600×1200" in result.message


def test_jpeg_is_progressive_and_metadata_is_removed() -> None:
    source = image_bytes("JPEG", (2000, 1500), "RGB", quality=95, exif=exif_bytes())

    result = optimize_image_sync(source, "image/jpeg")
    stored = _open(result.data)

    assert stored.format == "JPEG"
    assert stored.info.get("progressive") in {1}
    assert not stored.getexif()
    assert "icc_profile" not in stored.info


def test_png_with_alpha_becomes_webp_and_keeps_transparency() -> None:
    source = png_bytes((2400, 1200), alpha=True)

    result = optimize_image_sync(source, "image/png")
    stored = _open(result.data)

    assert result.resized is True
    assert result.content_type == "image/webp"
    assert result.suffix == ".webp"
    assert stored.format == "WEBP"
    assert stored.convert("RGBA").getpixel((10, 10))[3] == 0


def test_png_without_alpha_becomes_jpeg() -> None:
    result = optimize_image_sync(png_bytes((2000, 1000), alpha=False), "image/png")

    assert result.content_type == "image/jpeg"
    assert result.suffix == ".jpg"
    assert _open(result.data).format == "JPEG"


def test_gif_is_passed_through_byte_identical() -> None:
    source = gif_bytes((120, 90), frames=3)

    result = optimize_image_sync(source, "image/gif")

    assert result.resized is False
    assert result.data == source
    assert result.content_type == "image/gif"
    assert result.width == 120 and result.height == 90
    assert "unverändert" in result.message


def test_animated_webp_is_passed_through() -> None:
    source = image_bytes("WEBP", (100, 100), "RGB", frames=3)

    result = optimize_image_sync(source, "image/webp")

    assert result.resized is False
    assert result.data == source


def test_small_image_is_not_reencoded() -> None:
    source = jpeg_bytes((640, 480), quality=60)

    result = optimize_image_sync(source, "image/jpeg")

    assert result.resized is False
    assert result.data == source
    assert result.message.startswith("Bild unverändert übernommen")


def test_no_upscaling_for_small_images() -> None:
    source = jpeg_bytes((320, 200), quality=60)

    result = optimize_image_sync(source, "image/jpeg")

    assert (result.width, result.height) == (320, 200)


def test_tall_image_is_limited_on_the_long_edge() -> None:
    result = optimize_image_sync(jpeg_bytes((900, 3200)), "image/jpeg")

    assert (result.width, result.height) == (450, 1600)


def test_broken_image_raises_german_validation_error() -> None:
    with pytest.raises(ValidationError) as err:
        optimize_image_sync(b"kein bild", "image/jpeg")

    assert err.value.code == "image_invalid"
    assert "Bild" in err.value.message
    assert "Traceback" not in err.value.message


def test_empty_upload_raises_validation_error() -> None:
    with pytest.raises(ValidationError) as err:
        optimize_image_sync(b"", "image/jpeg")

    assert err.value.code == "image_invalid"


def test_pixel_limit_blocks_decompression_bombs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(imaging, "MAX_IMAGE_PIXELS", 100)

    with pytest.raises(ValidationError) as err:
        optimize_image_sync(png_bytes((200, 200)), "image/png")

    assert err.value.code == "image_invalid"
    assert "Megapixel" in err.value.message


def test_missing_pillow_fails_with_german_message(monkeypatch: pytest.MonkeyPatch) -> None:
    real_import = builtins.__import__

    def fake_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "PIL" or name.startswith("PIL."):
            raise ImportError("No module named 'PIL'")
        return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(builtins, "__import__", fake_import)

    with pytest.raises(ValidationError) as err:
        optimize_image_sync(b"egal", "image/jpeg")

    assert err.value.code == "pillow_missing"
    assert "Pillow" in err.value.message


def test_optimizer_is_idempotent_on_its_own_output() -> None:
    first = optimize_image_sync(jpeg_bytes((2400, 1800), quality=95), "image/jpeg")
    second = optimize_image_sync(first.data, first.content_type)

    assert first.resized is True
    assert second.resized is False
    assert second.data == first.data


def test_format_bytes_uses_german_notation() -> None:
    assert format_bytes(12 * 1024 * 1024) == "12,0 MB"
    assert format_bytes(285_000) == "278 KB"
    assert format_bytes(1) == "1 Byte"


def test_max_image_bytes_defaults_to_500_kib() -> None:
    assert MAX_IMAGE_BYTES == 512000


def test_is_oversized_respects_explicit_max_bytes() -> None:
    # 400 KiB + 1 Byte: unter der 500-KiB-Grenze, über einer 400-KiB-Grenze.
    size = 400 * 1024 + 1
    width, height = 800, 600

    assert is_oversized(width, height, size, 500 * 1024) is False
    assert is_oversized(width, height, size, 400 * 1024) is True
    # Lange Kante bleibt unabhängig von der Byte-Grenze wirksam.
    assert is_oversized(MAX_LONG_EDGE + 1, height, 1024, 500 * 1024) is True
    assert is_oversized(MAX_LONG_EDGE, height, 1024, 500 * 1024) is False


# --- Issue #322: Bilder drehen -------------------------------------------------


def _gradient(size: tuple[int, int] = (400, 300), *, alpha: bool = False) -> Image.Image:
    """Farbverlauf – erst dadurch sind Pixelvergleiche nach der Drehung aussagekräftig."""

    width, height = size
    horizontal = Image.linear_gradient("L").rotate(90, expand=True).resize((width, height))
    vertical = Image.linear_gradient("L").resize((width, height))
    image = Image.merge("RGB", (horizontal, vertical, horizontal.point(lambda value: 255 - value)))
    if alpha:
        rgba = image.convert("RGBA")
        rgba.putalpha(vertical)
        return rgba
    return image


def _encode(image: Image.Image, fmt: str = "PNG", **options: object) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format=fmt, **options)
    return buffer.getvalue()


def _max_channel_deviation(actual: Image.Image, expected: Image.Image) -> float:
    """Größte mittlere Abweichung je RGB-Kanal in Stufen (0…255)."""

    difference = ImageChops.difference(actual.convert("RGB"), expected.convert("RGB"))
    return max(ImageStat.Stat(difference).mean)


def test_rotate_reports_both_directions_with_german_message() -> None:
    source = jpeg_bytes((800, 600), quality=80)

    right = rotate_image_sync(source, direction="right", content_type="image/jpeg")
    left = rotate_image_sync(source, direction="left", content_type="image/jpeg")

    assert (right.degrees, left.degrees) == (90, -90)
    assert (right.width, right.height) == (600, 800)
    assert (left.width, left.height) == (600, 800)
    assert (right.original_width, right.original_height) == (800, 600)
    assert right.message == "Bild um 90° im Uhrzeigersinn gedreht (800×600 → 600×800)."
    assert left.message == ("Bild um 90° gegen den Uhrzeigersinn gedreht (800×600 → 600×800).")
    assert right.content_type == left.content_type == "image/jpeg"


def test_rotate_direction_constants_match_contract() -> None:
    assert imaging.ROTATE_LEFT == "left"
    assert imaging.ROTATE_RIGHT == "right"
    assert imaging.ROTATE_DIRECTIONS == ("left", "right")
    assert imaging.ROTATE_DEGREES == {"left": -90, "right": 90}


def test_rotate_left_after_right_restores_original_dimensions() -> None:
    source = _encode(_gradient(), "PNG")

    first = rotate_image_sync(source, direction="right", content_type="image/png")
    second = rotate_image_sync(first.data, direction="left", content_type="image/png")

    assert (first.width, first.height) == (300, 400)
    assert (second.width, second.height) == (400, 300)
    assert (second.original_width, second.original_height) == (300, 400)


def test_rotate_png_is_pixel_identical_after_one_and_four_rotations() -> None:
    image = _gradient()
    source = _encode(image, "PNG")

    once = rotate_image_sync(source, direction="right", content_type="image/png")
    expected = image.transpose(Image.Transpose.ROTATE_270)
    actual = _open(once.data)
    assert actual.size == expected.size == (300, 400)
    assert _max_channel_deviation(actual, expected) == 0

    data = source
    for _ in range(4):
        data = rotate_image_sync(data, direction="right", content_type="image/png").data
    four = _open(data)
    assert four.size == (400, 300)
    assert _max_channel_deviation(four, image) == 0


@pytest.mark.parametrize("fmt", ["JPEG", "WEBP"])
def test_rotate_lossy_formats_stay_within_documented_tolerance(fmt: str) -> None:
    image = _gradient()
    source = _encode(image, fmt, quality=95)

    result = rotate_image_sync(source, direction="right", content_type=f"image/{fmt.casefold()}")

    assert (result.width, result.height) == (300, 400)
    assert result.content_type == f"image/{fmt.casefold()}"
    deviation = _max_channel_deviation(
        _open(result.data), image.transpose(Image.Transpose.ROTATE_270)
    )
    assert deviation <= 2


@pytest.mark.parametrize("fmt", ["PNG", "WEBP"])
def test_rotate_keeps_alpha_for_png_and_webp(fmt: str) -> None:
    image = _gradient(alpha=True)
    source = _encode(image, fmt, quality=95)

    result = rotate_image_sync(source, direction="left", content_type=f"image/{fmt.casefold()}")

    stored = _open(result.data).convert("RGBA")
    assert stored.size == (300, 400)
    alpha = ImageStat.Stat(stored.getchannel("A")).mean[0]
    assert alpha == pytest.approx(ImageStat.Stat(image.getchannel("A")).mean[0], abs=2)
    assert stored.getchannel("A").getextrema()[0] == 0


def test_static_gif_stays_gif_and_keeps_transparency() -> None:
    image = Image.new("P", (80, 40), 0)
    image.putpalette([0, 0, 0, 200, 30, 30] + [0, 0, 0] * 254)
    image.paste(1, (0, 0, 40, 40))
    buffer = io.BytesIO()
    image.save(buffer, format="GIF", transparency=0)
    source = buffer.getvalue()

    result = rotate_image_sync(source, direction="right", content_type="image/gif")

    stored = _open(result.data)
    assert stored.format == "GIF"
    assert (result.width, result.height) == (40, 80)
    assert result.content_type == "image/gif"
    assert stored.info.get("transparency") == 0


def test_rotate_applies_exif_orientation_before_rotating() -> None:
    image = _gradient((400, 300))
    exif = Image.Exif()
    exif[0x0112] = 6  # sichtbar um 90° im Uhrzeigersinn gedreht
    source = _encode(image, "JPEG", quality=95, exif=exif.tobytes())

    result = rotate_image_sync(source, direction="right", content_type="image/jpeg")

    # Sichtbar sind 300×400; eine weitere Rechtsdrehung ergibt 400×300.
    assert (result.original_width, result.original_height) == (300, 400)
    assert (result.width, result.height) == (400, 300)
    expected = image.transpose(Image.Transpose.ROTATE_180)
    assert _max_channel_deviation(_open(result.data), expected) <= 2
    assert not _open(result.data).getexif()


@pytest.mark.parametrize(("fmt", "content_type"), [("GIF", "image/gif"), ("WEBP", "image/webp")])
def test_animated_images_are_rejected_with_german_message(fmt: str, content_type: str) -> None:
    source = image_bytes(fmt, (120, 90), "RGB", frames=3)

    with pytest.raises(ValidationError) as err:
        rotate_image_sync(source, direction="right", content_type=content_type)

    assert err.value.code == "image_animated"
    assert err.value.message == imaging.ANIMATED_ROTATE_MESSAGE


def test_invalid_direction_is_rejected_before_decoding() -> None:
    with pytest.raises(ValidationError) as err:
        rotate_image_sync(b"kein bild", direction="upward", content_type="image/jpeg")

    assert err.value.code == "validation_error"
    assert err.value.message == imaging.ROTATE_DIRECTION_MESSAGE


@pytest.mark.parametrize("data", [b"", b"kein bild", b"\xff\xd8kaputt"])
def test_corrupt_rotation_input_raises_image_invalid(data: bytes) -> None:
    with pytest.raises(ValidationError) as err:
        rotate_image_sync(data, direction="left", content_type="image/jpeg")

    assert err.value.code == "image_invalid"
    assert "Bild" in err.value.message


def test_rotate_respects_the_megapixel_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(imaging, "MAX_IMAGE_PIXELS", 100)

    with pytest.raises(ValidationError) as err:
        rotate_image_sync(png_bytes((200, 200)), direction="right", content_type="image/png")

    assert err.value.code == "image_invalid"
    assert "Megapixel" in err.value.message


def test_rotate_downscales_oversized_legacy_images() -> None:
    result = rotate_image_sync(
        jpeg_bytes((2400, 1200), quality=90), direction="right", content_type="image/jpeg"
    )

    assert result.downscaled is True
    assert (result.width, result.height) == (800, 1600)
    assert (result.original_width, result.original_height) == (2400, 1200)
    assert result.original_oversized is True
    assert result.oversized is False


def test_rotate_result_payloads_describe_before_and_after() -> None:
    source = _encode(_gradient(), "PNG")

    result = rotate_image_sync(source, direction="right", content_type="image/png")

    assert result.before_payload() == {
        "bytes": len(source),
        "width": 400,
        "height": 300,
        "content_type": "image/png",
        "oversized": False,
    }
    assert result.after_payload() == {
        "bytes": len(result.data),
        "width": 300,
        "height": 400,
        "content_type": "image/png",
        "oversized": False,
    }


def test_rotate_keeps_content_type_and_normalises_jpg_alias() -> None:
    png = rotate_image_sync(_encode(_gradient(), "PNG"), direction="left", content_type="image/png")
    alias = rotate_image_sync(jpeg_bytes((320, 240)), direction="left", content_type="image/jpg")
    unknown = rotate_image_sync(_encode(_gradient(), "PNG"), direction="left", content_type="x/y")

    assert png.content_type == "image/png"
    assert alias.content_type == "image/jpeg"
    assert unknown.content_type == "image/png"


async def test_async_rotate_image_matches_the_sync_contract() -> None:
    result = await imaging.async_rotate_image(
        jpeg_bytes((800, 600)), direction="right", content_type="image/jpeg"
    )

    assert (result.width, result.height) == (600, 800)
    assert result.degrees == 90


def test_image_info_payload_includes_mtime_and_animated_flag(tmp_path) -> None:
    path = tmp_path / "tanz.gif"
    path.write_bytes(gif_bytes((60, 40), frames=3))

    info = imaging.read_info_sync(path)

    assert info.animated is True
    assert info.mtime_ns == path.stat().st_mtime_ns
    assert info.to_dict()["mtime_ns"] == path.stat().st_mtime_ns
    assert info.to_dict()["animated"] is True


def test_metadata_cache_invalidate_drops_only_the_given_path(tmp_path) -> None:
    first = tmp_path / "eins.png"
    second = tmp_path / "zwei.png"
    first.write_bytes(png_bytes((40, 30)))
    second.write_bytes(png_bytes((40, 30)))
    cache = imaging.MetadataCache()

    first_key = (str(first), 1, 1, 1)
    second_key = (str(second), 1, 1, 1)
    cache.put(first_key, imaging.read_info_sync(first))
    cache.put(second_key, imaging.read_info_sync(second))
    cache.invalidate(first)

    assert len(cache) == 1
    assert cache.get(first_key) is None
    assert cache.get(second_key) is not None
