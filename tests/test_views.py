"""Tests der HTTP-API mit echten View-Handlern und Default Deny."""

from __future__ import annotations

import io
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from aiohttp import web
from aiohttp.test_utils import make_mocked_request
from image_helpers import jpeg_bytes, png_bytes

from custom_components.frickeldave_store import FrickeldaveStoreRuntime
from custom_components.frickeldave_store.ai import AIError, AIService
from custom_components.frickeldave_store.const import (
    API_PREFIX,
    DOMAIN,
    PANEL_MODULE_URL,
    VERSION,
)
from custom_components.frickeldave_store.models import SCHEMA_VERSION, Image
from custom_components.frickeldave_store.permissions import PermissionManager
from custom_components.frickeldave_store.products import ProductService
from custom_components.frickeldave_store.store import MAX_IMAGE_BYTES, CatalogStore
from custom_components.frickeldave_store.views import (
    VIEWS,
    ArchiveView,
    ArticleNumberView,
    DescriptionSuggestView,
    ExportView,
    ImagesOptimizeView,
    ImagesView,
    LocationsView,
    MeView,
    ProductsView,
    ProductView,
    SettingsView,
)


class FakeConfig:
    def __init__(self, root: Path) -> None:
        self._root = root

    def path(self, *parts: str) -> str:
        return str(self._root.joinpath(*parts))

    def config_dir(self) -> str:
        return str(self._root)


class FakeHass:
    def __init__(self, root: Path) -> None:
        self.data: dict[str, Any] = {}
        self.config = FakeConfig(root)

    async def async_add_executor_job(self, func: Any, *args: Any) -> Any:
        return func(*args)


class FakeRequest:
    def __init__(
        self,
        hass: FakeHass,
        user_id: str | None,
        *,
        query: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
        upload: Any | None = None,
    ) -> None:
        self.app = {"hass": hass}
        self._user = SimpleNamespace(id=user_id, name="Test") if user_id else None
        self.query = query or {}
        self._body = body
        self._upload = upload
        self.can_read_body = body is not None

    def get(self, key: str, default: Any = None) -> Any:
        if key == "hass_user":
            return self._user
        return default

    async def json(self) -> dict[str, Any]:
        if self._body is None:
            raise ValueError("kein JSON")
        return self._body

    async def post(self) -> Any:
        return {"file": self._upload} if self._upload is not None else {}


class FailingProvider:
    def __init__(self, error: AIError) -> None:
        self._error = error

    async def async_suggest(self, product: Any, images: Any, **kwargs: Any) -> Any:
        raise self._error

    async def async_close(self) -> None:
        return None


async def _setup(
    tmp_path: Path, users: dict[str, list[str]], provider: Any | None = None
) -> tuple[FakeHass, FrickeldaveStoreRuntime]:
    hass = FakeHass(tmp_path)
    store = CatalogStore(data_dir=tmp_path)
    await store.async_load()
    permissions = PermissionManager()
    permissions.load(users)
    runtime = FrickeldaveStoreRuntime(
        entry=None,  # type: ignore[arg-type]
        store=store,
        products=ProductService(store),
        permissions=permissions,
        ai=AIService(store, provider_factory=(lambda: provider) if provider else None),
        export_path=Path("export"),
    )
    hass.data[DOMAIN] = runtime
    return hass, runtime


def _payload(response: Any) -> Any:
    return json.loads(response.body.decode("utf-8"))


async def test_me_reports_roles_and_can_flags(tmp_path: Path) -> None:
    hass, _ = await _setup(tmp_path, {"user-1": ["product"], "admin": ["app_admin"]})
    response = await MeView().get(FakeRequest(hass, "user-1"))
    assert response.status == 200
    body = _payload(response)
    assert body["roles"] == ["product"]
    assert body["can"] == {"product": True, "finance": False, "app_admin": False}
    assert body["version"] == VERSION
    assert body["storage_schema_version"] == SCHEMA_VERSION
    assert body["panel_module_url"] == PANEL_MODULE_URL
    assert f"?v={VERSION}" in body["panel_module_url"]

    unknown = await MeView().get(FakeRequest(hass, "ghost"))
    assert _payload(unknown)["can"] == {"product": False, "finance": False, "app_admin": False}
    assert _payload(unknown)["version"] == VERSION


@pytest.mark.parametrize("view_class", [MeView, SettingsView])
async def test_missing_session_returns_401(tmp_path: Path, view_class: Any) -> None:
    hass, _ = await _setup(tmp_path, {"admin": ["app_admin"]})
    response = await view_class().get(FakeRequest(hass, None))
    assert response.status == 401
    body = _payload(response)
    assert body == {
        "error": {
            "code": "not_authenticated",
            "message": "Die Sitzung ist abgelaufen. Bitte die Seite neu laden.",
        }
    }


async def test_missing_role_still_returns_403(tmp_path: Path) -> None:
    hass, _ = await _setup(tmp_path, {"user-1": ["product"]})
    response = await SettingsView().get(FakeRequest(hass, "user-1"))
    assert response.status == 403
    assert _payload(response)["error"]["code"] == "forbidden"


async def test_default_deny_returns_403_without_protected_data(tmp_path: Path) -> None:
    hass, _ = await _setup(tmp_path, {"user-1": ["product"]})
    response = await ProductsView().get(FakeRequest(hass, "ghost"))
    assert response.status == 403
    body = _payload(response)
    assert body == {
        "error": {"code": "forbidden", "message": "Keine Berechtigung für diesen Bereich."}
    }
    assert b"products" not in response.body


async def test_revocation_applies_to_next_request(tmp_path: Path) -> None:
    hass, runtime = await _setup(tmp_path, {"user-1": ["product"]})
    assert (await ProductsView().get(FakeRequest(hass, "user-1"))).status == 200
    runtime.permissions.load({})
    assert (await ProductsView().get(FakeRequest(hass, "user-1"))).status == 403


async def test_product_flow_create_read_archive(tmp_path: Path) -> None:
    hass, _ = await _setup(tmp_path, {"user-1": ["product"]})
    create = await ProductsView().post(
        FakeRequest(hass, "user-1", body={"name": "Schild", "category": "LA", "price": 35})
    )
    assert create.status == 201
    product = _payload(create)
    assert product["articleNumber"].startswith("LA")

    read = await ProductView().get(FakeRequest(hass, "user-1"), product["articleNumber"])
    assert read.status == 200

    patch = await ProductView().patch(
        FakeRequest(hass, "user-1", body={"name": "Neues Schild"}),
        product["articleNumber"],
    )
    assert _payload(patch)["name"] == "Neues Schild"

    archive = await ArchiveView().post(FakeRequest(hass, "user-1"), product["articleNumber"])
    assert _payload(archive)["product"]["archived"] is True

    listing = await ProductsView().get(FakeRequest(hass, "user-1", query={"archived": "true"}))
    assert _payload(listing)["total"] == 1


async def test_invalid_filter_returns_validation_error(tmp_path: Path) -> None:
    hass, _ = await _setup(tmp_path, {"user-1": ["product"]})
    response = await ProductsView().get(FakeRequest(hass, "user-1", query={"category": "XX"}))
    assert response.status == 400
    assert _payload(response)["error"]["code"] == "validation_error"


async def test_products_can_be_sorted_by_image_size(tmp_path: Path) -> None:
    hass, runtime = await _setup(tmp_path, {"user-1": ["product"]})
    small = await runtime.products.async_create({"name": "Klein", "category": "LA"})
    large = await runtime.products.async_create({"name": "Groß", "category": "LA"})
    await runtime.store.images.async_write(large.article_number, "gross.jpg", b"x" * 500)
    stored = runtime.store.get_product(large.article_number)
    stored.images.append(Image(name="gross.jpg", is_main=True))
    runtime.store.put_product(stored)

    response = await ProductsView().get(FakeRequest(hass, "user-1", query={"sort": "size"}))
    body = _payload(response)

    assert response.status == 200
    assert body["total"] == 2
    assert [item["name"] for item in body["products"]] == ["Klein", "Groß"]
    assert body["products"][0]["images"] == []
    assert body["products"][1]["images"][0]["bytes"] == 500
    assert small.article_number != large.article_number

    descending = _payload(
        await ProductsView().get(
            FakeRequest(hass, "user-1", query={"sort": "size", "order": "desc"})
        )
    )
    assert [item["name"] for item in descending["products"]] == ["Groß", "Klein"]


async def test_products_reject_unknown_sort_value(tmp_path: Path) -> None:
    hass, _ = await _setup(tmp_path, {"user-1": ["product"]})

    response = await ProductsView().get(FakeRequest(hass, "user-1", query={"sort": "groesse"}))

    assert response.status == 400
    error = _payload(response)["error"]
    assert error["code"] == "validation_error"
    assert "'size'" in error["message"]


async def test_article_number_preview_endpoint(tmp_path: Path) -> None:
    hass, runtime = await _setup(tmp_path, {"user-1": ["product"]})

    response = await ArticleNumberView().get(FakeRequest(hass, "user-1", query={"category": "la"}))
    assert response.status == 200
    body = _payload(response)
    assert body["category"] == "LA"
    assert body["reserved"] is False
    assert len(body["articleNumber"]) == 6
    assert body["articleNumber"].startswith("LA")
    # Vorschlag reserviert nichts.
    assert runtime.store.article_numbers() == set()

    denied = await ArticleNumberView().get(FakeRequest(hass, "ghost", query={"category": "LA"}))
    assert denied.status == 403
    assert b"articleNumber" not in denied.body

    unknown = await ArticleNumberView().get(FakeRequest(hass, "user-1", query={"category": "XX"}))
    assert unknown.status == 400
    assert _payload(unknown)["error"]["code"] == "validation_error"

    missing = await ArticleNumberView().get(FakeRequest(hass, "user-1"))
    assert missing.status == 400
    assert _payload(missing)["error"]["code"] == "validation_error"


async def test_article_number_route_wins_over_product_route(tmp_path: Path) -> None:
    hass, _ = await _setup(tmp_path, {"user-1": ["product"]})
    assert VIEWS.index(ArticleNumberView) < VIEWS.index(ProductView)

    app = web.Application()
    for view_class in VIEWS:
        view_class().register(hass, app, app.router)  # type: ignore[arg-type]

    asset = make_mocked_request("GET", f"{API_PREFIX}/products/article-number", app=app)
    match = await app.router.resolve(asset)
    assert match.route.resource.canonical == f"{API_PREFIX}/products/article-number"

    product_request = make_mocked_request("GET", f"{API_PREFIX}/products/LA3K3X", app=app)
    product_match = await app.router.resolve(product_request)
    assert product_match["article_number"] == "LA3K3X"
    assert product_match.route.resource.canonical == f"{API_PREFIX}/products/{{article_number}}"


_JPEG = jpeg_bytes((64, 48))


async def test_eleventh_image_upload_rejected_via_api(tmp_path: Path) -> None:
    hass, _ = await _setup(tmp_path, {"user-1": ["product"]})
    create = await ProductsView().post(
        FakeRequest(hass, "user-1", body={"name": "Schild", "category": "LA"})
    )
    article = _payload(create)["articleNumber"]
    upload = SimpleNamespace(
        content_type="image/jpeg",
        filename="bild.jpg",
        file=io.BytesIO(_JPEG),
    )
    for _ in range(10):
        response = await ImagesView().post(FakeRequest(hass, "user-1", upload=upload), article)
        assert response.status == 201
        upload = SimpleNamespace(
            content_type="image/jpeg", filename="bild.jpg", file=io.BytesIO(_JPEG)
        )
    rejected = await ImagesView().post(
        FakeRequest(
            hass,
            "user-1",
            upload=SimpleNamespace(
                content_type="image/jpeg", filename="elf.jpg", file=io.BytesIO(b"elf")
            ),
        ),
        article,
    )
    assert rejected.status == 409
    assert _payload(rejected)["error"]["code"] == "image_limit"
    listing = await ImagesView().get(FakeRequest(hass, "user-1"), article)
    assert len(_payload(listing)["images"]) == 10


async def _product_with_one_image(
    tmp_path: Path,
) -> tuple[FakeHass, FrickeldaveStoreRuntime, str, list[str]]:
    """Produkt mit genau einem gespeicherten JPEG als Ausgangslage für Ablehnungstests."""

    hass, runtime = await _setup(tmp_path, {"user-1": ["product"]})
    create = await ProductsView().post(
        FakeRequest(hass, "user-1", body={"name": "Schild", "category": "LA"})
    )
    article = _payload(create)["articleNumber"]
    accepted = await ImagesView().post(
        FakeRequest(
            hass,
            "user-1",
            upload=SimpleNamespace(
                content_type="image/jpeg", filename="bild.jpg", file=io.BytesIO(_JPEG)
            ),
        ),
        article,
    )
    assert accepted.status == 201
    return hass, runtime, article, await runtime.store.images.async_list(article)


@pytest.mark.parametrize(
    ("content_type", "filename"),
    [("image/heic", "IMG_0001.HEIC"), ("application/pdf", "rechnung.pdf")],
)
async def test_disallowed_image_content_type_rejected_without_new_file(
    tmp_path: Path, content_type: str, filename: str
) -> None:
    hass, runtime, article, before = await _product_with_one_image(tmp_path)

    rejected = await ImagesView().post(
        FakeRequest(
            hass,
            "user-1",
            upload=SimpleNamespace(
                content_type=content_type, filename=filename, file=io.BytesIO(_JPEG)
            ),
        ),
        article,
    )

    assert rejected.status == 415
    assert _payload(rejected) == {
        "error": {
            "code": "unsupported_media_type",
            "message": "Nur JPEG, PNG, WebP und GIF werden unterstützt.",
        }
    }
    assert await runtime.store.images.async_list(article) == before
    assert len((await runtime.products.async_get(article)).images) == 1


async def test_oversized_image_rejected_without_new_file(tmp_path: Path) -> None:
    hass, runtime, article, before = await _product_with_one_image(tmp_path)
    oversized = SimpleNamespace(
        content_type="image/jpeg",
        filename="kamera.jpg",
        file=io.BytesIO(b"\x00" * (MAX_IMAGE_BYTES + 1)),
    )

    rejected = await ImagesView().post(FakeRequest(hass, "user-1", upload=oversized), article)

    assert rejected.status == 413
    assert _payload(rejected) == {
        "error": {"code": "file_too_large", "message": "Das Bild ist größer als 10 MB."}
    }
    assert await runtime.store.images.async_list(article) == before
    assert len((await runtime.products.async_get(article)).images) == 1


async def test_settings_requires_admin_and_hides_api_key(tmp_path: Path) -> None:
    hass, runtime = await _setup(tmp_path, {"user-1": ["product"], "admin": ["app_admin"]})
    runtime.store.update_settings({"ai": {"api_key": "super-secret"}})

    denied = await SettingsView().get(FakeRequest(hass, "user-1"))
    assert denied.status == 403
    assert b"super-secret" not in denied.body

    allowed = await SettingsView().get(FakeRequest(hass, "admin"))
    assert allowed.status == 200
    assert b"super-secret" not in allowed.body
    body = _payload(allowed)
    assert body["version"] == VERSION
    assert body["ai"]["api_key_set"] is True
    assert "api_key" not in body["ai"]
    assert {item["user_id"] for item in body["users"]} == {"user-1", "admin"}


async def test_settings_patch_does_not_echo_secret(tmp_path: Path) -> None:
    hass, _ = await _setup(tmp_path, {"admin": ["app_admin"]})
    response = await SettingsView().patch(
        FakeRequest(
            hass, "admin", body={"ai": {"api_key": "neu-geheim", "model": "deepseek-flash"}}
        )
    )
    assert response.status == 200
    assert b"neu-geheim" not in response.body
    assert _payload(response)["ai"]["api_key_set"] is True


async def test_settings_get_includes_image_limit(tmp_path: Path) -> None:
    hass, _ = await _setup(tmp_path, {"admin": ["app_admin"]})

    response = await SettingsView().get(FakeRequest(hass, "admin"))

    assert response.status == 200
    assert _payload(response)["images"] == {"max_bytes": 512000}


async def test_settings_patch_accepts_image_limit(tmp_path: Path) -> None:
    hass, runtime = await _setup(tmp_path, {"admin": ["app_admin"]})

    response = await SettingsView().patch(
        FakeRequest(hass, "admin", body={"images": {"max_bytes": 614400}})
    )

    assert response.status == 200
    assert _payload(response)["images"] == {"max_bytes": 614400}
    assert runtime.store.image_max_bytes == 614400


@pytest.mark.parametrize(
    "value",
    [1024, 10485761, True, "512000", 512000.5, None],
)
async def test_settings_patch_rejects_invalid_image_limit(tmp_path: Path, value: object) -> None:
    hass, runtime = await _setup(tmp_path, {"admin": ["app_admin"]})

    response = await SettingsView().patch(
        FakeRequest(hass, "admin", body={"images": {"max_bytes": value}})
    )

    assert response.status == 400
    assert _payload(response)["error"]["code"] == "validation_error"
    assert runtime.store.image_max_bytes == 512000


async def test_settings_patch_rejects_unknown_image_fields(tmp_path: Path) -> None:
    hass, _ = await _setup(tmp_path, {"admin": ["app_admin"]})

    response = await SettingsView().patch(
        FakeRequest(hass, "admin", body={"images": {"max_bytes": 512000, "quality": 80}})
    )

    assert response.status == 400
    assert _payload(response)["error"]["code"] == "validation_error"


async def test_ai_rate_limit_returns_readable_error_without_mutation(tmp_path: Path) -> None:
    provider = FailingProvider(AIError("Nutzungslimit erreicht.", code="ai_rate_limited"))
    hass, runtime = await _setup(tmp_path, {"user-1": ["product"]}, provider=provider)
    create = await ProductsView().post(
        FakeRequest(hass, "user-1", body={"name": "Schild", "category": "LA"})
    )
    article = _payload(create)["articleNumber"]
    before = json.dumps(runtime.store.data, sort_keys=True, ensure_ascii=False)

    response = await DescriptionSuggestView().post(FakeRequest(hass, "user-1"), article)
    assert response.status == 429
    assert _payload(response)["error"] == {
        "code": "ai_rate_limited",
        "message": "Nutzungslimit erreicht.",
    }
    assert json.dumps(runtime.store.data, sort_keys=True, ensure_ascii=False) == before


async def test_export_writes_catalog(tmp_path: Path) -> None:
    hass, runtime = await _setup(tmp_path, {"admin": ["app_admin"]})
    await runtime.products.async_create({"name": "Schild", "category": "LA"})
    response = await ExportView().post(FakeRequest(hass, "admin"))
    assert response.status == 200
    body = _payload(response)
    assert body["products"] == 1
    assert Path(body["path"]).is_file()
    assert json.loads(Path(body["path"]).read_text(encoding="utf-8"))["products"][0][
        "articleNumber"
    ].startswith("LA")


async def test_unconfigured_runtime_returns_503(tmp_path: Path) -> None:
    hass = FakeHass(tmp_path)
    response = await ProductsView().get(FakeRequest(hass, "user-1"))
    assert response.status == 503
    assert _payload(response)["error"]["code"] == "not_loaded"


@pytest.mark.parametrize("role", ["product", "app_admin"])
async def test_unknown_user_cannot_reach_any_protected_view(tmp_path: Path, role: str) -> None:
    hass, _ = await _setup(tmp_path, {"user-1": [role]})
    for view, method in (
        (ProductsView(), "post"),
        (SettingsView(), "get"),
    ):
        handler = getattr(view, method)
        response = await handler(FakeRequest(hass, "ghost", body={"name": "x", "category": "LA"}))
        assert response.status == 403


async def test_locations_endpoint_lists_stock_for_product_role(tmp_path: Path) -> None:
    hass, runtime = await _setup(tmp_path, {"user-1": ["product"]})
    await runtime.products.async_create(
        {"name": "Schild", "category": "LA", "stock": {"lager": 2, "verkaufsschrank": 0}}
    )

    response = await LocationsView().get(FakeRequest(hass, "user-1"))
    assert response.status == 200
    locations = _payload(response)["locations"]
    assert [item["id"] for item in locations] == ["lager", "verkaufsschrank"]
    assert [item["name"] for item in locations] == ["Lager", "Verkaufsschrank"]
    assert locations[0]["position"] == 0
    assert locations[0]["stock_total"] == 2
    assert locations[0]["products_with_stock"] == 1
    assert locations[1]["stock_total"] == 0

    denied = await LocationsView().get(FakeRequest(hass, "ghost"))
    assert denied.status == 403


async def test_settings_patch_renames_and_deletes_locations(tmp_path: Path) -> None:
    hass, runtime = await _setup(tmp_path, {"admin": ["app_admin"]})
    product = await runtime.products.async_create(
        {"name": "Schild", "category": "LA", "stock": {"lager": 2, "verkaufsschrank": 1}}
    )

    renamed = await SettingsView().patch(
        FakeRequest(
            hass,
            "admin",
            body={
                "locations": [
                    {"id": "lager", "name": "Werkstatt"},
                    {"id": "verkaufsschrank", "name": "Verkaufsschrank"},
                ]
            },
        )
    )
    assert renamed.status == 200
    body = _payload(renamed)
    assert [item["name"] for item in body["locations"]] == ["Werkstatt", "Verkaufsschrank"]
    assert runtime.store.get_product(product.article_number).stock == {
        "lager": 2,
        "verkaufsschrank": 1,
    }

    rejected = await SettingsView().patch(
        FakeRequest(hass, "admin", body={"locations": [{"id": "lager", "name": "Werkstatt"}]})
    )
    assert rejected.status == 409
    error = _payload(rejected)["error"]
    assert error["code"] == "conflict"
    assert "Verkaufsschrank" in error["message"]
    assert "1 Stück" in error["message"]
    assert len(runtime.store.locations()) == 2


async def test_settings_patch_rejects_publish_and_keeps_stored_data(tmp_path: Path) -> None:
    """0.2.0 liest und schreibt ``settings.publish`` nicht mehr (Rückfallweg)."""

    hass, runtime = await _setup(tmp_path, {"admin": ["app_admin"]})
    runtime.store.settings["publish"] = {"repository": "alt/repo", "token": "ghp-alt"}

    response = await SettingsView().patch(
        FakeRequest(hass, "admin", body={"publish": {"token": "ghp-neu"}})
    )

    assert response.status == 400
    error = _payload(response)["error"]
    assert error["code"] == "validation_error"
    assert "publish" in error["message"]
    # Alte Daten bleiben unangetastet, werden aber nicht mehr ausgeliefert.
    assert runtime.store.settings["publish"] == {"repository": "alt/repo", "token": "ghp-alt"}
    assert "publish" not in _payload(await SettingsView().get(FakeRequest(hass, "admin")))


async def test_description_suggest_accepts_optional_instructions(tmp_path: Path) -> None:
    class RecordingProvider:
        def __init__(self) -> None:
            self.calls: list[dict[str, Any]] = []

        async def async_suggest(self, product: Any, images: Any, **kwargs: Any) -> Any:
            from custom_components.frickeldave_store.ai import Suggestion

            self.calls.append(kwargs)
            return Suggestion(text="Vorschlag", tags=["Holz", "Neu"])

        async def async_close(self) -> None:
            return None

    provider = RecordingProvider()
    hass, runtime = await _setup(tmp_path, {"user-1": ["product"]}, provider=provider)
    create = await ProductsView().post(
        FakeRequest(hass, "user-1", body={"name": "Schild", "category": "LA"})
    )
    article = _payload(create)["articleNumber"]
    runtime.store.add_tag("Holz")
    await runtime.store.async_save()

    plain = await DescriptionSuggestView().post(FakeRequest(hass, "user-1"), article)
    assert plain.status == 200
    assert _payload(plain)["instructions_used"] is False
    assert provider.calls[0]["instructions"] == ""

    extended = await DescriptionSuggestView().post(
        FakeRequest(hass, "user-1", body={"instructions": "Erwähne die Gravur."}), article
    )
    assert extended.status == 200
    result = _payload(extended)
    assert provider.calls[1]["instructions"] == "Erwähne die Gravur."
    assert result["instructions_used"] is True
    assert result["tags"] == ["Holz"]
    assert result["rejected_tags"] == ["Neu"]
    assert set(result["available_tags"]) == {"Holz"}
    assert "Neu" not in runtime.store.tag_names()

    invalid = await DescriptionSuggestView().post(
        FakeRequest(hass, "user-1", body={"unbekannt": True}), article
    )
    assert invalid.status == 400


async def test_product_responses_include_image_metadata(tmp_path: Path) -> None:
    hass, runtime = await _setup(tmp_path, {"user-1": ["product"]})
    create = await ProductsView().post(
        FakeRequest(hass, "user-1", body={"name": "Schild", "category": "LA"})
    )
    article = _payload(create)["articleNumber"]
    upload = SimpleNamespace(
        content_type="image/jpeg",
        filename="bild.jpg",
        file=io.BytesIO(jpeg_bytes((320, 240), quality=60)),
    )
    response = await ImagesView().post(FakeRequest(hass, "user-1", upload=upload), article)
    body = _payload(response)

    assert body["resized"] is False
    assert body["original"]["width"] == 320
    assert body["stored"]["content_type"] == "image/jpeg"
    stored = body["images"][0]
    assert stored["width"] == 320 and stored["height"] == 240
    assert stored["oversized"] is False

    listing = _payload(await ProductsView().get(FakeRequest(hass, "user-1")))
    image = listing["products"][0]["images"][0]
    assert image["bytes"] > 0
    assert image["width"] == 320
    assert image["content_type"] == "image/jpeg"
    detail = _payload(await ProductView().get(FakeRequest(hass, "user-1"), article))
    assert detail["images"][0]["oversized"] is False


async def test_optimize_endpoint_requires_product_role(tmp_path: Path) -> None:
    hass, _ = await _setup(tmp_path, {"user-1": ["product"], "gast": []})
    create = await ProductsView().post(
        FakeRequest(hass, "user-1", body={"name": "Schild", "category": "LA"})
    )
    article = _payload(create)["articleNumber"]

    denied = await ImagesOptimizeView().post(FakeRequest(hass, "gast"), article)
    assert denied.status == 403


async def test_optimize_endpoint_resizes_existing_images(tmp_path: Path) -> None:
    hass, runtime = await _setup(tmp_path, {"user-1": ["product"]})
    create = await ProductsView().post(
        FakeRequest(hass, "user-1", body={"name": "Schild", "category": "LA"})
    )
    article = _payload(create)["articleNumber"]
    await runtime.store.images.async_write(
        article, "LA0001-01.png", png_bytes((2400, 1200), alpha=True)
    )
    product = runtime.store.get_product(article)
    product.images.append(Image(name="LA0001-01.png", is_main=True))
    runtime.store.put_product(product)
    await runtime.store.async_save()

    response = await ImagesOptimizeView().post(FakeRequest(hass, "user-1"), article)
    body = _payload(response)

    assert response.status == 200
    assert body["summary"]["count"] == 1
    assert body["results"][0]["resized"] is True
    assert body["images"][0]["name"] == "LA0001-01.webp"
    assert body["images"][0]["oversized"] is False

    again = _payload(await ImagesOptimizeView().post(FakeRequest(hass, "user-1"), article))
    assert again["results"][0]["resized"] is False
