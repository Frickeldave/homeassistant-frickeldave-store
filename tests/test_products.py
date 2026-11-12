"""Tests für die Produktdomain: Artikelnummern, Soft-Delete, Filter, Bilder, Bestand."""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from string import ascii_uppercase

import pytest
from image_helpers import gif_bytes, jpeg_bytes, png_bytes, webp_bytes

import custom_components.frickeldave_store.products as products_module
from custom_components.frickeldave_store import imaging
from custom_components.frickeldave_store.models import (
    MAX_IMAGES,
    Image,
    ImageLimitError,
    NotFoundError,
    Product,
    ValidationError,
)
from custom_components.frickeldave_store.products import (
    ProductFilter,
    ProductService,
    generate_article_number,
    product_matches,
    sort_products,
)
from custom_components.frickeldave_store.store import MAX_IMAGE_BYTES, CatalogStore


async def _service(tmp_path: Path) -> tuple[CatalogStore, ProductService]:
    store = CatalogStore(data_dir=tmp_path)
    await store.async_load()
    return store, ProductService(store)


async def _create(service: ProductService, **overrides: object) -> Product:
    payload: dict[str, object] = {
        "name": "Testprodukt",
        "category": "LA",
        "price": 10.0,
        "tags": ["Deko"],
    }
    payload.update(overrides)
    return await service.async_create(payload)


async def test_create_generates_unique_formatted_article_numbers(tmp_path: Path) -> None:
    _, service = await _service(tmp_path)
    products = await asyncio.gather(
        *[_create(service, name=f"Produkt {index}") for index in range(20)]
    )
    numbers = [product.article_number for product in products]
    assert len(set(numbers)) == 20
    for number in numbers:
        assert len(number) == 6
        assert number.startswith("LA")


async def test_parallel_creation_never_duplicates(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)

    async def _create_one(index: int) -> str:
        product = await service.async_create(
            {"name": f"Parallel {index}", "category": "WO", "price": 1}
        )
        return product.article_number

    numbers = await asyncio.gather(*[_create_one(index) for index in range(30)])
    assert len(set(numbers)) == 30
    assert len(store.article_numbers()) == 30


async def test_article_number_is_immutable(tmp_path: Path) -> None:
    _, service = await _service(tmp_path)
    product = await _create(service)
    with pytest.raises(ValidationError):
        await service.async_update(product.article_number, {"articleNumber": "LAXXXX"})


async def test_category_is_immutable(tmp_path: Path) -> None:
    _, service = await _service(tmp_path)
    product = await _create(service, category="EP")
    with pytest.raises(ValidationError) as err:
        await service.async_update(product.article_number, {"category": "LA"})
    assert err.value.code == "category_immutable"
    updated = await service.async_update(product.article_number, {"name": "Neu"})
    assert updated.category == "EP"
    assert updated.name == "Neu"


async def test_soft_delete_only(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    archived = await service.async_archive(product.article_number)
    assert archived.archived is True
    assert not hasattr(service, "async_delete")
    assert not hasattr(store, "delete_product")
    assert await service.async_list() == ([], 0)
    archived_list, total = await service.async_list(ProductFilter(archived=True))
    assert total == 1
    assert archived_list[0].article_number == product.article_number
    with pytest.raises(NotFoundError):
        await service.async_get(product.article_number)


async def test_filters_category_or_tags_or_rest_and(tmp_path: Path) -> None:
    _, service = await _service(tmp_path)
    a = await _create(service, name="Lampe", category="LA", tags=["Deko", "Holz"], stock=1)
    b = await _create(service, name="Vase", category="EP", tags=["Deko"], stock=0)
    c = await _create(service, name="Box", category="LA", tags=["Holz"], stock=0, visible=False)
    d = await _create(service, name="Archiv", category="LA", tags=["Deko", "Holz"])
    await service.async_archive(d.article_number)

    category_or, total = await service.async_list(ProductFilter(categories=["LA", "EP"]))
    assert total == 3
    assert {item.article_number for item in category_or} == {
        a.article_number,
        b.article_number,
        c.article_number,
    }

    tags_or, total = await service.async_list(ProductFilter(tags=["Deko", "Holz"]))
    assert total == 3
    assert {item.article_number for item in tags_or} == {
        a.article_number,
        b.article_number,
        c.article_number,
    }

    combined, total = await service.async_list(
        ProductFilter(categories=["LA"], tags=["Holz"], in_stock=True)
    )
    assert total == 1
    assert combined[0].article_number == a.article_number

    invisible, total = await service.async_list(ProductFilter(visibility="invisible"))
    assert total == 1
    assert invisible[0].article_number == c.article_number

    search, total = await service.async_list(ProductFilter(search="vase"))
    assert total == 1
    assert search[0].article_number == b.article_number


async def test_tag_filter_matches_any_selected_tag(tmp_path: Path) -> None:
    _, service = await _service(tmp_path)
    both = await _create(service, name="Beides", tags=["a", "b"], stock=1)
    only_a = await _create(service, name="Nur A", tags=["a"], stock=1)
    only_b = await _create(service, name="Nur B", tags=["B"], stock=1)
    neither = await _create(service, name="Keins", tags=["c"], stock=1)

    any_tag, total = await service.async_list(ProductFilter(tags=["a", "b"]))
    assert total == 3
    assert {item.article_number for item in any_tag} == {
        both.article_number,
        only_a.article_number,
        only_b.article_number,
    }
    assert neither.article_number not in {item.article_number for item in any_tag}

    single, total = await service.async_list(ProductFilter(tags=["b"]))
    assert total == 2
    assert {item.article_number for item in single} == {
        both.article_number,
        only_b.article_number,
    }

    without_stock = await _create(service, name="Ohne Bestand", category="EP", tags=["a"])
    combined, total = await service.async_list(
        ProductFilter(categories=["LA"], tags=["a", "b"], in_stock=True)
    )
    assert total == 3
    assert {item.article_number for item in combined} == {
        both.article_number,
        only_a.article_number,
        only_b.article_number,
    }
    assert without_stock.article_number not in {item.article_number for item in combined}


async def test_sorting_is_stable_and_bidirectional(tmp_path: Path) -> None:
    _, service = await _service(tmp_path)
    first = await _create(service, name="Beta", price=20)
    second = await _create(service, name="alpha", price=5)
    third = await _create(service, name="Beta", price=10)

    ascending, _ = await service.async_list(ProductFilter(sort="name", order="asc"))
    assert [item.name for item in ascending] == ["alpha", "Beta", "Beta"]
    assert ascending[1].article_number < ascending[2].article_number

    descending_price, _ = await service.async_list(ProductFilter(sort="price", order="desc"))
    assert [item.price for item in descending_price] == [20.0, 10.0, 5.0]
    assert descending_price[0].article_number == first.article_number
    assert descending_price[-1].article_number == second.article_number
    assert descending_price[1].article_number == third.article_number

    filtered, _ = await service.async_list(
        ProductFilter(sort="price", order="asc", categories=["LA"], limit=2)
    )
    assert [item.price for item in filtered] == [5.0, 10.0]


def _sortable_product(
    article_number: str,
    *,
    name: str,
    category: str = "LA",
    price: float = 0.0,
    stock: dict[str, int] | None = None,
    visible: bool = True,
    archived: bool = False,
) -> Product:
    return Product(
        article_number=article_number,
        name=name,
        category=category,
        price=price,
        stock=dict(stock or {}),
        visible=visible,
        archived=archived,
    )


@pytest.mark.parametrize("sort", ["name", "price", "category", "stock", "status", "size"])
def test_filter_accepts_all_sort_keys(sort: str) -> None:
    assert ProductFilter.from_query({"sort": sort}).sort == sort


def test_unknown_sort_value_names_all_allowed_keys() -> None:
    with pytest.raises(ValidationError) as err:
        ProductFilter.from_query({"sort": "groesse"})
    assert err.value.code == "validation_error"
    message = err.value.message
    assert message.startswith("sort muss ")
    for key in ("name", "price", "category", "stock", "status", "size"):
        assert f"'{key}'" in message


def test_sort_by_category_uses_label_order_and_name_tiebreak() -> None:
    products = [
        _sortable_product("WO0002", name="Brett", category="WO"),
        _sortable_product("LA0002", name="Lampe", category="LA"),
        _sortable_product("EP0002", name="Vase", category="EP"),
        _sortable_product("WO0001", name="Brett", category="WO"),
        _sortable_product("3D0001", name="Anhänger", category="3D"),
        _sortable_product("SB0001", name="Schale", category="SB"),
    ]

    # Sichtbare Labels: 3D-Druck < Epoxidharz < Holz < Laser < Steinmasse.
    ascending = sort_products(products, "category", "asc")
    assert [item.category for item in ascending] == ["3D", "EP", "WO", "WO", "LA", "SB"]
    assert [item.article_number for item in ascending[2:4]] == ["WO0001", "WO0002"]

    # Innerhalb der Kategorie nach Name, dann Artikelnummer.
    same_category = [
        _sortable_product("WO0002", name="Brett", category="WO"),
        _sortable_product("WO0001", name="Brett", category="WO"),
        _sortable_product("WO0003", name="Anhänger", category="WO"),
    ]
    ordered = sort_products(same_category, "category", "asc")
    assert [item.article_number for item in ordered] == ["WO0003", "WO0001", "WO0002"]

    descending = sort_products(products, "category", "desc")
    assert [item.category for item in descending] == ["SB", "LA", "WO", "WO", "EP", "3D"]
    # desc dreht nur die Kategorie; der Tiebreaker bleibt aufsteigend.
    assert [item.article_number for item in descending[2:4]] == ["WO0001", "WO0002"]


def test_sort_by_stock_uses_total_across_all_locations() -> None:
    products = [
        # Gesamt 2, aber auf beide Lagerstätten verteilt.
        _sortable_product("LA0001", name="Gleich", stock={"lager": 1, "verkaufsschrank": 1}),
        # Gesamt 2, nur im Lager: nach „Lager“ allein wäre diese Nummer größer.
        _sortable_product("LA0002", name="Gleich", stock={"lager": 2}),
        # Gesamt 3, aber kein Lagerbestand.
        _sortable_product("LA0003", name="Mehr", stock={"verkaufsschrank": 3}),
        _sortable_product("LA0004", name="Zebra", stock={"lager": 4}),
        _sortable_product("LA0005", name="Alpha", stock={"lager": 4}),
    ]

    ascending = sort_products(products, "stock", "asc")
    assert [item.total_stock() for item in ascending] == [2, 2, 3, 4, 4]
    # Gleiche Summe: erst Name, dann Artikelnummer.
    assert [item.article_number for item in ascending[:2]] == ["LA0001", "LA0002"]
    assert [item.article_number for item in ascending[3:]] == ["LA0005", "LA0004"]

    descending = sort_products(products, "stock", "desc")
    assert [item.total_stock() for item in descending] == [4, 4, 3, 2, 2]
    # Auch bei desc bleibt der Tiebreaker aufsteigend.
    assert [item.article_number for item in descending[:2]] == ["LA0005", "LA0004"]
    assert [item.article_number for item in descending[3:]] == ["LA0001", "LA0002"]


def test_sort_by_status_active_visible_first() -> None:
    products = [
        _sortable_product("LA0001", name="Archiv sichtbar", archived=True),
        _sortable_product("LA0002", name="Unsichtbar", visible=False),
        _sortable_product("LA0003", name="Archiv unsichtbar", visible=False, archived=True),
        _sortable_product("LA0004", name="Aktiv", visible=True),
        _sortable_product("LA0005", name="Aktiv", visible=True),
    ]

    ascending = sort_products(products, "status", "asc")
    assert [item.article_number for item in ascending] == [
        "LA0004",
        "LA0005",
        "LA0002",
        "LA0001",
        "LA0003",
    ]

    descending = sort_products(products, "status", "desc")
    assert [item.article_number for item in descending] == [
        "LA0003",
        "LA0001",
        "LA0002",
        "LA0004",
        "LA0005",
    ]


async def test_service_lists_with_new_sort_keys(tmp_path: Path) -> None:
    _, service = await _service(tmp_path)
    holz = await _create(service, name="Brett", category="WO", stock={"lager": 1})
    laser = await _create(
        service, name="Lampe", category="LA", stock={"lager": 5, "verkaufsschrank": 2}
    )

    by_category, _ = await service.async_list(ProductFilter(sort="category", order="desc"))
    assert [item.article_number for item in by_category] == [
        laser.article_number,
        holz.article_number,
    ]

    by_stock, _ = await service.async_list(ProductFilter(sort="stock", order="asc"))
    assert [item.article_number for item in by_stock] == [holz.article_number, laser.article_number]


async def _attach_image(store: CatalogStore, product: Product, name: str, size: int) -> None:
    """Bilddatei mit exakt ``size`` Bytes an ein Produkt hängen (ohne Optimierung)."""

    await store.images.async_write(product.article_number, name, b"x" * size)
    stored = store.get_product(product.article_number)
    stored.images.append(Image(name=name, is_main=not stored.images))
    store.put_product(stored)


async def test_sort_by_size_uses_file_totals_and_stable_ties(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    empty = await _create(service, name="Ohne Bild")
    small = await _create(service, name="Klein")
    medium = await _create(service, name="Mittel")
    large = await _create(service, name="Groß")
    tie_zulu = await _create(service, name="Zulu")
    tie_alpha = await _create(service, name="Alpha")
    outside = await _create(service, name="Außen", category="EP")

    await _attach_image(store, small, "klein.jpg", 10)
    await _attach_image(store, medium, "mittel.jpg", 200)
    await _attach_image(store, large, "gross-1.jpg", 200)
    await _attach_image(store, large, "gross-2.jpg", 100)  # Summe 300
    await _attach_image(store, tie_zulu, "zulu.jpg", 100)
    await _attach_image(store, tie_alpha, "alpha.jpg", 100)
    await _attach_image(store, outside, "aussen.jpg", 999)

    ascending, total = await service.async_list(ProductFilter(sort="size", order="asc"))
    assert total == 7
    assert [item.article_number for item in ascending] == [
        empty.article_number,
        small.article_number,
        tie_alpha.article_number,
        tie_zulu.article_number,
        medium.article_number,
        large.article_number,
        outside.article_number,
    ]

    descending, _ = await service.async_list(ProductFilter(sort="size", order="desc"))
    assert [item.article_number for item in descending] == [
        outside.article_number,
        large.article_number,
        medium.article_number,
        tie_alpha.article_number,
        tie_zulu.article_number,
        small.article_number,
        empty.article_number,
    ]

    # Sortiert wird vor Limit/Offset; ``total`` zählt alle gefilterten Produkte.
    page, total = await service.async_list(
        ProductFilter(categories=["LA"], sort="size", order="asc", offset=1, limit=2)
    )
    assert total == 6
    assert [item.article_number for item in page] == [
        small.article_number,
        tie_alpha.article_number,
    ]


async def test_preview_article_number_format_and_uniqueness(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    await _create(service, name="Aktiv", category="WO")
    archived = await _create(service, name="Archiv", category="WO")
    await service.async_archive(archived.article_number)
    existing = store.article_numbers()
    assert archived.article_number in existing

    for _ in range(30):
        preview = await service.async_preview_article_number("wo")
        assert preview["category"] == "WO"
        assert preview["reserved"] is False
        assert len(preview["articleNumber"]) == 6
        assert preview["articleNumber"].startswith("WO")
        assert preview["articleNumber"] not in existing

    # Der Vorschlag reserviert nichts: der Store bleibt unverändert.
    assert store.article_numbers() == existing


async def test_preview_article_number_skips_existing_and_archived(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, service = await _service(tmp_path)
    active = await _create(service, name="Aktiv", category="SB")
    archived = await _create(service, name="Archiv", category="SB")
    await service.async_archive(archived.article_number)
    taken = store.article_numbers()
    free = next(
        number
        for number in (f"SB{a}{b}ZZ" for a in ascii_uppercase for b in ascii_uppercase)
        if number not in taken
    )
    candidates = iter([archived.article_number, active.article_number, free])
    monkeypatch.setattr(
        products_module, "generate_article_number", lambda category: next(candidates)
    )

    preview = await service.async_preview_article_number("sb")

    assert preview == {"articleNumber": free, "category": "SB", "reserved": False}


async def test_preview_article_number_rejects_unknown_category(tmp_path: Path) -> None:
    _, service = await _service(tmp_path)
    with pytest.raises(ValidationError) as err:
        await service.async_preview_article_number("XX")
    assert err.value.code == "validation_error"
    assert "Unbekannte Kategorie" in err.value.message


def test_filter_combination_semantics_directly() -> None:
    product = Product(
        article_number="LA0001",
        name="Schild",
        category="LA",
        tags=["Hochzeit", "Holz"],
        stock={"lager": 2, "verkaufsschrank": 1},
    )
    assert product_matches(product, ProductFilter(categories=["LA"]))
    assert not product_matches(product, ProductFilter(categories=["EP"]))
    assert product_matches(product, ProductFilter(tags=["holz", "HOCHZEIT"]))
    assert product_matches(product, ProductFilter(tags=["holz"]))
    assert product_matches(product, ProductFilter(tags=["Deko", "Holz"]))
    assert not product_matches(product, ProductFilter(tags=["Deko"]))
    assert not product_matches(product, ProductFilter(tags=["Deko", "Metall"]))
    assert not product_matches(product, ProductFilter(tags=["Metall"]))
    rules = ProductFilter(sort="name", order="asc")
    assert sort_products([product], rules.sort, rules.order) == [product]


async def test_max_ten_images_and_eleventh_rejected_without_persistence(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)

    for _ in range(MAX_IMAGES):
        await service.async_add_image(
            product.article_number,
            filename="bild.jpg",
            content_type="image/jpeg",
            data=jpeg_bytes((64, 48)),
        )
    product_after = await service.async_get(product.article_number)
    assert len(product_after.images) == MAX_IMAGES
    stored_files = await store.images.async_list(product.article_number)
    assert len(stored_files) == MAX_IMAGES

    with pytest.raises(ImageLimitError) as err:
        await service.async_add_image(
            product.article_number,
            filename="elf.jpg",
            content_type="image/jpeg",
            data=b"\xff\xd8elf",
        )
    assert err.value.code == "image_limit"
    assert len(await store.images.async_list(product.article_number)) == MAX_IMAGES
    assert len((await service.async_get(product.article_number)).images) == MAX_IMAGES


async def test_image_order_and_main_image(tmp_path: Path) -> None:
    _, service = await _service(tmp_path)
    product = await _create(service)
    for _ in range(3):
        await service.async_add_image(
            product.article_number,
            filename="bild.png",
            content_type="image/png",
            data=png_bytes((64, 48)),
        )
    images = await service.async_list_images(product.article_number)
    assert images[0]["is_main"] is True
    assert all(item["url"].startswith("/api/frickeldave_store/products/") for item in images)

    names = [item["name"] for item in images]
    await service.async_set_main_image(product.article_number, names[2])
    reordered = await service.async_list_images(product.article_number)
    assert [item["name"] for item in reordered if item["is_main"]] == [names[2]]

    await service.async_set_image_order(product.article_number, list(reversed(names)))
    after = await service.async_list_images(product.article_number)
    assert [item["name"] for item in after] == list(reversed(names))

    with pytest.raises(ValidationError):
        await service.async_set_image_order(product.article_number, names[:2])

    await service.async_delete_image(product.article_number, names[1])
    remaining = await service.async_list_images(product.article_number)
    assert names[1] not in [item["name"] for item in remaining]
    assert sum(1 for item in remaining if item["is_main"]) == 1


async def test_stock_bookings_update_both_counters(tmp_path: Path) -> None:
    _, service = await _service(tmp_path)
    product = await _create(service)

    result = await service.async_book_stock(
        product.article_number, {"type": "in", "quantity": 5}, ha_user_id="user-1"
    )
    assert result["product"]["stock"]["lager"] == 5
    assert result["booking"]["ha_user_id"] == "user-1"
    assert result["booking"]["locationId"] == "lager"

    result = await service.async_book_stock(
        product.article_number, {"type": "transfer", "quantity": 2}
    )
    assert result["product"]["stock"]["lager"] == 3
    assert result["product"]["stock"]["verkaufsschrank"] == 2
    assert result["booking"]["targetLocationId"] == "verkaufsschrank"

    result = await service.async_book_stock(product.article_number, {"type": "out", "quantity": 1})
    assert result["product"]["stock"]["lager"] == 2

    result = await service.async_book_stock(
        product.article_number, {"type": "correction", "quantity": 7}
    )
    assert result["product"]["stock"]["lager"] == 7

    bookings = await service.async_list_bookings(product.article_number)
    assert len(bookings) == 4
    assert {item["type"] for item in bookings} == {"in", "transfer", "out", "correction"}

    with pytest.raises(ValidationError):
        await service.async_book_stock(product.article_number, {"type": "out", "quantity": 0})


async def test_tags_management_removes_tag_from_products(tmp_path: Path) -> None:
    _, service = await _service(tmp_path)
    product = await _create(service, tags=["Deko"])
    await service.async_create_tag({"name": "Neu"})
    assert (await service.async_list_tags()) == ["Deko", "Neu"]

    await service.async_delete_tag("Deko")
    assert (await service.async_list_tags()) == ["Neu"]
    refreshed = await service.async_get(product.article_number)
    assert refreshed.tags == []


def test_generated_numbers_avoid_ambiguous_characters() -> None:
    for _ in range(100):
        assert not set(generate_article_number("SB")[2:]) & set("IO01")


# ---------------------------------------------------------------- Bildoptimierung


async def test_upload_returns_optimization_metadata_and_changes_suffix(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)

    result = await service.async_add_image(
        product.article_number,
        filename="gross.png",
        content_type="image/png",
        data=png_bytes((2400, 1200), alpha=True),
    )

    assert result["resized"] is True
    assert result["original"]["content_type"] == "image/png"
    assert result["original"]["width"] == 2400
    assert result["stored"]["content_type"] == "image/webp"
    assert result["stored"]["width"] == 1600
    assert result["stored"]["height"] == 800
    assert result["stored"]["bytes"] <= result["original"]["bytes"]
    assert "verkleinert" in result["optimize_message"]
    assert result["images"][0]["name"].endswith(".webp")
    assert await store.images.async_list(product.article_number) == [result["images"][0]["name"]]


async def test_upload_passthrough_reports_resized_false(tmp_path: Path) -> None:
    _, service = await _service(tmp_path)
    product = await _create(service)

    result = await service.async_add_image(
        product.article_number,
        filename="klein.jpg",
        content_type="image/jpeg",
        data=jpeg_bytes((640, 480), quality=60),
    )

    assert result["resized"] is False
    assert result["original"] == result["stored"]
    assert result["optimize_message"].startswith("Bild unverändert übernommen")
    assert result["images"][0]["name"].endswith(".jpg")


async def test_upload_rejects_undecodable_image(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)

    with pytest.raises(ValidationError) as err:
        await service.async_add_image(
            product.article_number,
            filename="kaputt.jpg",
            content_type="image/jpeg",
            data=b"\xff\xd8keinbild",
        )

    assert err.value.code == "image_invalid"
    assert await store.images.async_list(product.article_number) == []
    assert (await service.async_get(product.article_number)).images == []


@pytest.mark.parametrize("content_type", ["image/heic", "image/heif", "application/pdf"])
async def test_upload_rejects_unsupported_content_type(tmp_path: Path, content_type: str) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    await service.async_add_image(
        product.article_number,
        filename="bild.jpg",
        content_type="image/jpeg",
        data=jpeg_bytes((64, 48)),
    )
    before = await store.images.async_list(product.article_number)

    with pytest.raises(ValidationError) as err:
        await service.async_add_image(
            product.article_number,
            filename="foto.heic",
            content_type=content_type,
            data=jpeg_bytes((64, 48)),
        )

    assert err.value.code == "unsupported_media_type"
    assert err.value.message == "Nur JPEG, PNG, WebP und GIF werden unterstützt."
    assert await store.images.async_list(product.article_number) == before
    assert len((await service.async_get(product.article_number)).images) == 1


async def test_upload_rejects_file_above_hard_limit(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)

    with pytest.raises(ValidationError) as err:
        await service.async_add_image(
            product.article_number,
            filename="kamera.jpg",
            content_type="image/jpeg",
            data=b"\x00" * (MAX_IMAGE_BYTES + 1),
        )

    assert err.value.code == "file_too_large"
    assert err.value.message == "Das Bild ist größer als 10 MB."
    assert await store.images.async_list(product.article_number) == []
    assert (await service.async_get(product.article_number)).images == []


async def test_image_payloads_expose_size_metadata(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    await store.images.async_write(
        product.article_number, "LA0001-01.jpg", jpeg_bytes((800, 600), quality=60)
    )
    stored = store.get_product(product.article_number)
    stored.images.append(Image(name="LA0001-01.jpg", is_main=True))
    store.put_product(stored)
    await store.async_save()

    images = await service.async_list_images(product.article_number)
    assert len(images) == 1
    assert images[0]["bytes"] > 0
    assert images[0]["width"] == 800 and images[0]["height"] == 600
    assert images[0]["content_type"] == "image/jpeg"
    assert images[0]["oversized"] is False


@pytest.mark.parametrize(
    ("size", "name", "pad", "expected"),
    [
        ((1600, 1200), "klein.jpg", False, False),
        ((1601, 900), "lang.jpg", False, True),
        ((800, 600), "schwer.jpg", True, True),
    ],
)
async def test_oversized_flag_uses_long_edge_and_bytes(
    tmp_path: Path, size: tuple[int, int], name: str, pad: bool, expected: bool
) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    data = jpeg_bytes(size, quality=95)
    if pad:
        # Sicherstellen, dass die Byte-Grenze wirklich überschritten wird.
        data += b"\x00" * (500 * 1024)
    await store.images.async_write(product.article_number, name, data)
    stored = store.get_product(product.article_number)
    stored.images.append(Image(name=name, is_main=True))
    store.put_product(stored)
    await store.async_save()

    listing = await service.async_list_images(product.article_number)
    assert listing[0]["oversized"] is expected
    payload = await service.async_serialise_product(await service.async_get(product.article_number))
    assert payload["images"][0]["oversized"] is expected


async def test_serialise_products_reports_dimensions_for_list(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    await service.async_add_image(
        product.article_number,
        filename="bild.jpg",
        content_type="image/jpeg",
        data=jpeg_bytes((320, 240), quality=60),
    )

    products, _ = await service.async_list()
    payloads = await service.async_serialise_products(products)

    image = payloads[0]["images"][0]
    assert image["width"] == 320 and image["height"] == 240
    assert image["content_type"] == "image/jpeg"
    assert image["bytes"] > 0
    assert "oversized" in image


async def test_optimize_images_keeps_order_and_main_image(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    article = product.article_number
    await store.images.async_write(article, "LA0001-01.jpg", jpeg_bytes((2400, 1200)))
    await store.images.async_write(article, "LA0001-02.png", png_bytes((2400, 1200), alpha=True))
    stored = store.get_product(article)
    stored.images = [
        Image(name="LA0001-01.jpg", is_main=False),
        Image(name="LA0001-02.png", is_main=True),
    ]
    store.put_product(stored)
    await store.async_save()

    result = await service.async_optimize_images(article)

    assert result["summary"]["count"] == 2
    assert result["summary"]["bytes_after"] < result["summary"]["bytes_before"]
    assert result["summary"]["saved_percent"] > 0
    names = [item["name"] for item in result["images"]]
    assert names == ["LA0001-01.jpg", "LA0001-02.webp"]
    assert [item["is_main"] for item in result["images"]] == [False, True]
    assert all(item["resized"] for item in result["results"])
    assert result["results"][1]["previous_name"] == "LA0001-02.png"
    assert await store.images.async_list(article) == ["LA0001-01.jpg", "LA0001-02.webp"]
    assert list(store.backup_dir.glob("*-pre-image-optimize.json"))


async def test_optimize_images_is_idempotent(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    await store.images.async_write(
        product.article_number, "LA0001-01.jpg", jpeg_bytes((2400, 1200))
    )
    stored = store.get_product(product.article_number)
    stored.images.append(Image(name="LA0001-01.jpg", is_main=True))
    store.put_product(stored)
    await store.async_save()

    first = await service.async_optimize_images(product.article_number)
    second = await service.async_optimize_images(product.article_number)

    assert first["results"][0]["resized"] is True
    assert all(item["resized"] is False for item in second["results"])
    assert second["summary"]["bytes_before"] == second["summary"]["bytes_after"]
    assert second["summary"]["saved_percent"] == 0.0


async def test_optimize_images_continues_after_broken_file(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    article = product.article_number
    await store.images.async_write(article, "LA0001-01.jpg", b"kaputt")
    await store.images.async_write(article, "LA0001-02.jpg", jpeg_bytes((2400, 1200)))
    stored = store.get_product(article)
    stored.images = [Image(name="LA0001-01.jpg", is_main=True), Image(name="LA0001-02.jpg")]
    store.put_product(stored)
    await store.async_save()

    result = await service.async_optimize_images(article)

    assert len(result["results"]) == 2
    failed = result["results"][0]
    assert failed["error"] and "Bild" in failed["error"]
    assert failed["resized"] is False
    assert result["results"][1]["resized"] is True
    assert result["summary"]["count"] == 2
    assert await store.images.async_list(article) == ["LA0001-01.jpg", "LA0001-02.jpg"]


# --- Issue #322: Bilder drehen -------------------------------------------------


async def _seed_images(
    store: CatalogStore, product: Product, files: list[tuple[str, bytes, bool]]
) -> None:
    for name, data, _ in files:
        await store.images.async_write(product.article_number, name, data)
    stored = store.get_product(product.article_number)
    stored.images = [Image(name=name, is_main=is_main) for name, _, is_main in files]
    store.put_product(stored)
    await store.async_save()
    imaging.metadata_cache().clear()


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


async def test_rotate_image_swaps_dimensions_and_keeps_list_metadata(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    article = product.article_number
    files = [
        (f"{article}-01.jpg", jpeg_bytes((800, 600), quality=80), False),
        (f"{article}-02.png", png_bytes((400, 300)), True),
        (f"{article}-03.webp", webp_bytes((320, 240)), False),
    ]
    await _seed_images(store, product, files)
    before = await service.async_list_images(article)

    rotated = await service.async_rotate_image(article, f"{article}-02.png", direction="right")

    result = rotated["result"]
    assert result["name"] == f"{article}-02.png"
    assert result["direction"] == "right"
    assert result["degrees"] == 90
    assert result["before"] == {
        "bytes": len(files[1][1]),
        "width": 400,
        "height": 300,
        "content_type": "image/png",
        "oversized": False,
    }
    assert result["after"]["width"] == 300 and result["after"]["height"] == 400
    assert result["message"] == "Bild um 90° im Uhrzeigersinn gedreht (400×300 → 300×400)."

    images = rotated["images"]
    assert [item["name"] for item in images] == [name for name, _, _ in files]
    assert len(images) == 3
    assert sum(1 for item in images if item["is_main"]) == 1
    target = images[1]
    assert target["is_main"] is True
    assert target["name"].endswith(".png")
    assert target["content_type"] == "image/png"
    assert (target["width"], target["height"]) == (300, 400)
    assert target["bytes"] == result["after"]["bytes"] != before[1]["bytes"]
    assert target["mtime_ns"] != before[1]["mtime_ns"]
    assert (images[0]["width"], images[0]["height"]) == (800, 600)
    assert images[0]["bytes"] == before[0]["bytes"]


async def test_rotate_image_keeps_ten_image_limit(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    article = product.article_number
    await _seed_images(
        store,
        product,
        [(f"{article}-{index:02d}.jpg", jpeg_bytes((120, 80)), index == 0) for index in range(10)],
    )

    rotated = await service.async_rotate_image(article, f"{article}-07.jpg", direction="left")

    assert len(rotated["images"]) == MAX_IMAGES
    with pytest.raises(ImageLimitError) as err:
        await service.async_add_image(
            article,
            filename="elf.jpg",
            content_type="image/jpeg",
            data=jpeg_bytes((64, 48)),
        )
    assert err.value.code == "image_limit"


async def test_rotate_image_backs_up_original_and_metadata_snapshot(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    article = product.article_number
    original = jpeg_bytes((640, 480), quality=80)
    name = f"{article}-01.jpg"
    await _seed_images(store, product, [(name, original, True)])

    await service.async_rotate_image(article, name, direction="right")

    backups = sorted((tmp_path / "backups" / "images" / article).iterdir())
    assert len(backups) == 1
    assert backups[0].name.endswith(f"-{name}")
    assert backups[0].read_bytes() == original
    snapshots = list((tmp_path / "backups").glob("*-pre-image-rotate.json"))
    assert len(snapshots) == 1


async def test_second_rotation_keeps_the_true_original_backup(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    article = product.article_number
    original = jpeg_bytes((640, 480), quality=80)
    name = f"{article}-01.jpg"
    await _seed_images(store, product, [(name, original, True)])

    await service.async_rotate_image(article, name, direction="right")
    await service.async_rotate_image(article, name, direction="right")

    backups = sorted((tmp_path / "backups" / "images" / article).iterdir())
    assert len(backups) == 2
    assert backups[0].read_bytes() == original
    assert backups[1].read_bytes() != original
    restored = await service.async_list_images(article)
    assert (restored[0]["width"], restored[0]["height"]) == (640, 480)


async def test_rotate_animated_gif_leaves_the_file_untouched(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    article = product.article_number
    name = f"{article}-01.gif"
    data = gif_bytes((120, 90), frames=3)
    await _seed_images(store, product, [(name, data, True)])

    with pytest.raises(ValidationError) as err:
        await service.async_rotate_image(article, name, direction="right")

    assert err.value.code == "image_animated"
    assert err.value.message == imaging.ANIMATED_ROTATE_MESSAGE
    assert _digest(await store.images.async_read(article, name)) == _digest(data)
    assert not (tmp_path / "backups" / "images" / article).exists()


async def test_rotate_corrupt_file_leaves_the_original_byte_identical(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    article = product.article_number
    name = f"{article}-01.jpg"
    data = b"\xff\xd8keinbild"
    await _seed_images(store, product, [(name, data, True)])

    with pytest.raises(ValidationError) as err:
        await service.async_rotate_image(article, name, direction="left")

    assert err.value.code == "image_invalid"
    assert _digest(await store.images.async_read(article, name)) == _digest(data)


async def test_rotate_rejects_unknown_name_and_invalid_direction(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    article = product.article_number
    name = f"{article}-01.jpg"
    data = jpeg_bytes((320, 240))
    await _seed_images(store, product, [(name, data, True)])

    with pytest.raises(NotFoundError) as missing:
        await service.async_rotate_image(article, f"{article}-09.jpg", direction="right")
    with pytest.raises(ValidationError) as invalid:
        await service.async_rotate_image(article, name, direction="upward")

    assert missing.value.code == "not_found"
    assert invalid.value.code == "validation_error"
    assert invalid.value.message == imaging.ROTATE_DIRECTION_MESSAGE
    assert _digest(await store.images.async_read(article, name)) == _digest(data)


async def test_rotate_read_failure_keeps_the_original(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    article = product.article_number
    name = f"{article}-01.jpg"
    data = jpeg_bytes((320, 240))
    await _seed_images(store, product, [(name, data, True)])
    real_read_bytes = Path.read_bytes

    def failing_read_bytes(self: Path) -> bytes:
        if self.name == name:
            raise OSError("Lesefehler")
        return real_read_bytes(self)

    monkeypatch.setattr(Path, "read_bytes", failing_read_bytes)

    with pytest.raises(ValidationError) as err:
        await service.async_rotate_image(article, name, direction="right")

    assert err.value.code == "image_write_failed"
    assert err.value.message == products_module.IMAGE_ROTATE_WRITE_FAILED_MESSAGE
    monkeypatch.undo()
    assert _digest(await store.images.async_read(article, name)) == _digest(data)


async def test_manual_restore_from_backup_restores_original_metadata(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    article = product.article_number
    original = jpeg_bytes((640, 480), quality=80)
    name = f"{article}-01.jpg"
    await _seed_images(store, product, [(name, original, True)])
    before = await service.async_list_images(article)

    await service.async_rotate_image(article, name, direction="right")
    backup = next((tmp_path / "backups" / "images" / article).iterdir())
    await store.images.async_write(article, name, backup.read_bytes())
    imaging.metadata_cache().clear()

    restored = await service.async_list_images(article)
    assert (restored[0]["width"], restored[0]["height"]) == (640, 480)
    assert restored[0]["bytes"] == before[0]["bytes"]
    assert (await store.images.async_read(article, name)) == original


async def test_rotate_recomputes_oversized_with_the_configured_limit(tmp_path: Path) -> None:
    store, service = await _service(tmp_path)
    store.update_settings({"images": {"max_bytes": 50 * 1024}})
    product = await _create(service)
    article = product.article_number
    name = f"{article}-01.jpg"
    # Lange Kante klein, Datei durch Altbestand-Padding über der eingestellten Grenze.
    data = jpeg_bytes((400, 300), quality=80) + b"\x00" * (52 * 1024)
    await _seed_images(store, product, [(name, data, True)])

    rotated = await service.async_rotate_image(article, name, direction="right")

    assert rotated["result"]["before"]["oversized"] is True
    assert rotated["result"]["after"]["bytes"] < 50 * 1024
    assert rotated["result"]["after"]["oversized"] is False
    assert rotated["images"][0]["oversized"] is False


async def test_rotate_pixel_limit_leaves_the_original_byte_identical(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    article = product.article_number
    name = f"{article}-01.png"
    data = png_bytes((400, 300))
    await _seed_images(store, product, [(name, data, True)])
    monkeypatch.setattr(imaging, "MAX_IMAGE_PIXELS", 100)

    with pytest.raises(ValidationError) as err:
        await service.async_rotate_image(article, name, direction="right")

    assert err.value.code == "image_invalid"
    assert await store.images.async_read(article, name) == data


async def test_failed_store_save_restores_the_original_image(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, service = await _service(tmp_path)
    product = await _create(service)
    article = product.article_number
    name = f"{article}-01.jpg"
    original = jpeg_bytes((640, 480), quality=80)
    await _seed_images(store, product, [(name, original, True)])

    async def failing_save(*args: object, **kwargs: object) -> None:
        raise OSError("Speichern fehlgeschlagen")

    monkeypatch.setattr(store, "async_save", failing_save)

    with pytest.raises(OSError):
        await service.async_rotate_image(article, name, direction="right")

    assert await store.images.async_read(article, name) == original
