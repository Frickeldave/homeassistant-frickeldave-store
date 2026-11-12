"""Produkt-Domain: CRUD, Artikelnummern, Filter, Bilder, Tags und Bestände."""

from __future__ import annotations

import asyncio
import logging
import secrets
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

from .const import API_PREFIX
from .imaging import (
    ROTATE_DIRECTION_MESSAGE,
    ROTATE_DIRECTIONS,
    async_inspect_paths,
    async_optimize_image,
    content_type_for_name,
    metadata_cache,
    read_info_sync,
    rotate_image_sync,
)
from .models import (
    ARTICLE_NUMBER_LENGTH,
    BOOKING_TYPES,
    CATEGORIES,
    CATEGORY_LABELS,
    MAX_IMAGES,
    VISIBILITY_VALUES,
    ConflictError,
    Image,
    ImageLimitError,
    ImageRotateResultDict,
    NotFoundError,
    Product,
    StockBooking,
    StoreError,
    ValidationError,
    default_location_ids,
    next_image_name,
    normalise_bool,
    normalise_tags,
    to_iso,
    validate_create_payload,
    validate_update_payload,
)
from .store import ALLOWED_CONTENT_TYPES, MAX_IMAGE_BYTES, CatalogStore, ImageStorage

_LOGGER = logging.getLogger(__name__)

#: Zeichen ohne Verwechslungsgefahr (kein I, O, 0, 1).
_ARTICLE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

#: Unterordner der Original-Sicherung vor einer Bilddrehung (Issue #322).
IMAGE_BACKUP_SUBDIR: Final = "images"
#: Fehlertext bei fehlgeschlagenem Lesen/Schreiben der gedrehten Datei.
IMAGE_ROTATE_WRITE_FAILED_MESSAGE: Final = (
    "Das gedrehte Bild konnte nicht gespeichert werden. Die Originaldatei bleibt unverändert."
)

#: Erlaubte Sortierschlüssel (Panel, HTTP- und WebSocket-API). ``size``
#: sortiert nach der Summe der Bilddateien (siehe :meth:`ProductService.async_list`).
SORT_KEYS: Final[tuple[str, ...]] = ("name", "price", "category", "stock", "status", "size")
SORT_VALUES_MESSAGE: Final = "sort muss " + ", ".join(f"'{key}'" for key in SORT_KEYS) + " sein."


def generate_article_number(category: str) -> str:
    """Artikelnummer: Kategoriepräfix plus fünf Zufallszeichen."""

    category = category.upper()
    if category not in CATEGORIES:
        raise ValidationError(f"Unbekannte Kategorie: {category!r}")
    suffix_length = ARTICLE_NUMBER_LENGTH - len(category)
    suffix = "".join(secrets.choice(_ARTICLE_ALPHABET) for _ in range(suffix_length))
    return f"{category}{suffix}"


@dataclass(slots=True)
class ProductFilter:
    """Filter- und Sortierregeln (Kategorie ODER, Tags ODER, Rest UND)."""

    search: str = ""
    categories: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    customizable: bool | None = None
    in_stock: bool | None = None
    in_cabinet: bool | None = None
    location: str | None = None
    in_location: bool | None = None
    visibility: str | None = None
    archived: bool = False
    sort: str = "name"
    order: str = "asc"
    limit: int | None = None
    offset: int = 0

    @classmethod
    def from_query(cls, params: Mapping[str, str]) -> ProductFilter:
        categories = [part.strip().upper() for part in params.get("category", "").split(",")]
        categories = [part for part in categories if part]
        unknown = [part for part in categories if part not in CATEGORIES]
        if unknown:
            raise ValidationError(f"Unbekannte Kategorie: {', '.join(unknown)}")

        visibility = (params.get("visibility") or "").strip().lower() or None
        if visibility is not None and visibility not in VISIBILITY_VALUES:
            raise ValidationError("visibility muss 'visible' oder 'invisible' sein.")

        sort = (params.get("sort") or "name").strip().lower()
        if sort not in SORT_KEYS:
            raise ValidationError(SORT_VALUES_MESSAGE)
        order = (params.get("order") or "asc").strip().lower()
        if order not in {"asc", "desc"}:
            raise ValidationError("order muss 'asc' oder 'desc' sein.")

        def _optional_bool(key: str) -> bool | None:
            raw = params.get(key)
            if raw is None or raw == "":
                return None
            return normalise_bool(raw)

        limit_raw = (params.get("limit") or "").strip()
        offset_raw = (params.get("offset") or "0").strip()
        try:
            limit = int(limit_raw) if limit_raw else None
            offset = int(offset_raw) if offset_raw else 0
        except ValueError as err:
            raise ValidationError("limit/offset müssen ganze Zahlen sein.") from err
        if limit is not None and limit < 0:
            raise ValidationError("limit darf nicht negativ sein.")
        if offset < 0:
            raise ValidationError("offset darf nicht negativ sein.")

        return cls(
            search=(params.get("search") or "").strip(),
            categories=categories,
            tags=normalise_tags(params.get("tags", "")),
            customizable=_optional_bool("customizable"),
            in_stock=_optional_bool("in_stock"),
            in_cabinet=_optional_bool("in_cabinet"),
            location=(params.get("location") or "").strip() or None,
            in_location=_optional_bool("in_location"),
            visibility=visibility,
            archived=_optional_bool("archived") or False,
            sort=sort,
            order=order,
            limit=limit,
            offset=offset,
        )


def product_matches(
    product: Product,
    filters: ProductFilter,
    locations: list[dict[str, str]] | None = None,
) -> bool:
    """Alle Filterregeln anwenden (Kategorie ODER, Tags ODER, übrige UND).

    ``in_stock``/``in_cabinet`` bleiben aus Kompatibilität auf die erste bzw.
    zweite Lagerstätte bezogen; ``location`` + ``in_location`` filtern dynamisch.
    """

    ids = [str(item["id"]) for item in locations] if locations else default_location_ids()

    if product.archived != filters.archived:
        return False
    if filters.categories and product.category not in filters.categories:
        return False
    product_tags = {tag.casefold() for tag in product.tags}
    if filters.tags and not any(tag.casefold() in product_tags for tag in filters.tags):
        return False
    if filters.search:
        needle = filters.search.casefold()
        haystack = " ".join(
            [
                product.name,
                product.description,
                product.article_number,
                " ".join(product.tags),
            ]
        ).casefold()
        if needle not in haystack:
            return False
    if filters.customizable is not None and product.customizable != filters.customizable:
        return False
    if filters.in_stock is not None:
        first = ids[0] if ids else ""
        if (product.stock_for(first) > 0) != filters.in_stock:
            return False
    if filters.in_cabinet is not None:
        second = ids[1] if len(ids) > 1 else ""
        if (product.stock_for(second) > 0) != filters.in_cabinet:
            return False
    if filters.location is not None or filters.in_location is not None:
        target = filters.location or (ids[0] if ids else "")
        if target and target not in ids:
            raise ValidationError(f"Unbekannte Lagerstätte: {target!r}.")
        if (
            filters.in_location is not None
            and (product.stock_for(target) > 0) != filters.in_location
        ):
            return False
    if filters.visibility is not None:
        is_visible = product.visible
        if filters.visibility == "visible" and not is_visible:
            return False
        if filters.visibility == "invisible" and is_visible:
            return False
    return True


def _category_order(category: str) -> tuple[int, str]:
    """Kategorie nach sichtbarem Label (alphabetisch), unbekannte Codes danach.

    Sortiert wird nach dem Label, nicht nach dem Rohcode: sichtbar ist z. B.
    ``Holz`` (``WO``) vor ``Laser`` (``LA``). Unbekannte Codes (etwa aus
    Altbeständen) landen hinter allen bekannten Kategorien und sind dort nach
    Rohcode stabil.
    """

    label = CATEGORY_LABELS.get(category.upper(), "")
    if not label:
        return (1, category.casefold())
    return (0, label.casefold())


def _status_order(product: Product) -> tuple[int, int]:
    """Aktiv vor archiviert, sichtbar vor unsichtbar."""

    return (1 if product.archived else 0, 0 if product.visible else 1)


def _primary_key(
    sort: str, image_bytes: Mapping[str, int] | None = None
) -> Callable[[Product], Any]:
    if sort == "price":
        return lambda item: item.price
    if sort == "category":
        return lambda item: _category_order(item.category)
    if sort == "stock":
        return lambda item: item.total_stock()
    if sort == "status":
        return _status_order
    if sort == "size":
        totals = image_bytes or {}
        return lambda item: totals.get(item.article_number, 0)
    return lambda item: item.name.casefold()


def sort_products(
    products: list[Product],
    sort: str,
    order: str,
    *,
    image_bytes: Mapping[str, int] | None = None,
) -> list[Product]:
    """Stabile Sortierung nach ``sort``; Tiebreaker bleiben immer aufsteigend.

    ``order=desc`` dreht nur das Hauptkriterium. Der Tiebreaker (Name bzw.
    Artikelnummer) folgt bewusst weiter aufsteigend, damit gleiche Werte in
    beiden Richtungen dieselbe, deterministische Reihenfolge haben.

    ``sort='size'`` benötigt die vorab ermittelten Bildgrößen je Artikelnummer
    (``image_bytes``); fehlende Einträge zählen als 0 Bytes.
    """

    if sort in {"category", "stock", "status", "size"}:
        tie_break: Callable[[Product], tuple[str, ...]] = lambda item: (  # noqa: E731
            item.name.casefold(),
            item.article_number,
        )
    else:
        tie_break = lambda item: (item.article_number,)  # noqa: E731

    presorted = sorted(products, key=tie_break)
    return sorted(
        presorted,
        key=_primary_key(sort, image_bytes),
        reverse=order == "desc",
    )


class ProductService:
    """Service-Layer um :class:`CatalogStore`; alle Methoden sind asynchron."""

    def __init__(self, store: CatalogStore) -> None:
        self._store = store

    @property
    def store(self) -> CatalogStore:
        return self._store

    # ------------------------------------------------------------------ Produkte
    async def async_create(self, payload: dict[str, Any], *, actor: str = "") -> Product:
        values = validate_create_payload(payload, location_ids=self._store.location_ids())
        async with self._store.lock:
            existing = self._store.article_numbers()
            article_number = generate_article_number(values["category"])
            attempts = 0
            while article_number in existing:
                attempts += 1
                if attempts > 1000:  # pragma: no cover - praktisch unerreichbar
                    raise ConflictError("Keine freie Artikelnummer gefunden.")
                article_number = generate_article_number(values["category"])
            now = to_iso()
            product = Product(
                article_number=article_number,
                created_at=now,
                updated_at=now,
                name=values["name"],
                category=values["category"],
                description=values["description"],
                price=values["price"],
                size=values["size"],
                tags=values["tags"],
                customizable=values["customizable"],
                visible=values["visible"],
                stock=values["stock"],
            )
            self._store.put_product(product)
            for tag in product.tags:
                self._store.add_tag(tag)
            await self._store.async_save()
        return product

    async def async_preview_article_number(self, category: str) -> dict[str, Any]:
        """Vorschlag für eine Artikelnummer beim Anlegen – bewusst **nicht reserviert**.

        Die Nummer entsteht nach derselben Regel wie in :meth:`async_create`
        (Kategoriepräfix + Zufallszeichen) und wird gegen alle vorhandenen
        Artikelnummern geprüft, inklusive archivierter Produkte. Reserviert wird
        sie nicht: maßgeblich bleibt die Erzeugung in :meth:`async_create`.
        Kollidiert der Vorschlag bis zum Speichern (paralleles Anlegen), entsteht
        dort eine andere Nummer und die Antwort von ``POST /products`` enthält die
        tatsächlich vergebene.
        """

        normalized = category.strip().upper()
        article_number = generate_article_number(normalized)
        existing = self._store.article_numbers()
        attempts = 0
        while article_number in existing:
            attempts += 1
            if attempts > 1000:  # pragma: no cover - praktisch unerreichbar
                raise ConflictError("Keine freie Artikelnummer gefunden.")
            article_number = generate_article_number(normalized)
        return {"articleNumber": article_number, "category": normalized, "reserved": False}

    async def async_update(self, article_number: str, payload: dict[str, Any]) -> Product:
        async with self._store.lock:
            product = self._store.get_product(article_number)
            changes = validate_update_payload(
                payload,
                immutable_category=product.category,
                location_ids=self._store.location_ids(),
            )
            for key, value in changes.items():
                if key == "stock":
                    product.stock.update(value)
                else:
                    setattr(product, key, value)
            for tag in product.tags:
                self._store.add_tag(tag)
            self._store.put_product(product)
            await self._store.async_save()
        return product

    async def async_archive(self, article_number: str) -> Product:
        """Soft-Delete: setzt ``archived``; es gibt keinen Hard-Delete-Pfad."""

        async with self._store.lock:
            product = self._store.get_product(article_number, include_archived=True)
            product.archived = True
            self._store.put_product(product)
            await self._store.async_save()
        return product

    async def async_restore(self, article_number: str) -> Product:
        async with self._store.lock:
            product = self._store.get_product(article_number, include_archived=True)
            product.archived = False
            self._store.put_product(product)
            await self._store.async_save()
        return product

    async def async_get(self, article_number: str, *, include_archived: bool = False) -> Product:
        product = self._store.get_product(article_number, include_archived=include_archived)
        self._sync_images(product)
        return product

    async def async_list(self, filters: ProductFilter | None = None) -> tuple[list[Product], int]:
        rules = filters or ProductFilter()
        locations = self._store.locations()
        products = [
            item for item in self._store.products() if product_matches(item, rules, locations)
        ]
        image_bytes = await self._image_bytes_totals(products) if rules.sort == "size" else None
        products = sort_products(products, rules.sort, rules.order, image_bytes=image_bytes)
        total = len(products)
        if rules.offset:
            products = products[rules.offset :]
        if rules.limit is not None:
            products = products[: rules.limit]
        return products, total

    async def _image_bytes_totals(self, products: list[Product]) -> dict[str, int]:
        """Summe der Bilddateien je Artikelnummer – ein Executor-Lauf für alle Bilder.

        Grundlage ist dieselbe Metadaten-Erhebung wie bei der Produktliste
        (``_sync_images_all`` + ``async_inspect_paths``); es gibt also keine
        N+1-Aufrufe pro Produkt.
        """

        if not products:
            return {}
        self._sync_images_all(products)
        paths: list[Path] = []
        owners: list[str] = []
        for product in products:
            for image in product.images:
                paths.append(self._store.images.path_for(product.article_number, image.name))
                owners.append(product.article_number)
        infos = await async_inspect_paths(paths, self._store.image_max_bytes)
        totals: dict[str, int] = {}
        for article_number, info in zip(owners, infos, strict=True):
            totals[article_number] = totals.get(article_number, 0) + info.bytes
        return totals

    # ------------------------------------------------------------------ Tags
    async def async_list_tags(self) -> list[str]:
        return self._store.tag_names()

    async def async_create_tag(self, payload: dict[str, Any]) -> str:
        name = str(payload.get("name", "")).strip() if isinstance(payload, dict) else ""
        if not name:
            raise ValidationError("name ist ein Pflichtfeld.")
        async with self._store.lock:
            tag = self._store.add_tag(name)
            await self._store.async_save()
        return tag

    async def async_delete_tag(self, name: str) -> None:
        async with self._store.lock:
            self._store.remove_tag(name)
            await self._store.async_save()

    # ------------------------------------------------------------------ Bestand
    async def async_book_stock(
        self,
        article_number: str,
        payload: dict[str, Any],
        *,
        ha_user_id: str = "",
    ) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValidationError("Anfragekörper muss ein JSON-Objekt sein.")
        booking_type = str(payload.get("type", "")).strip().lower()
        if booking_type not in BOOKING_TYPES:
            raise ValidationError(f"type muss eine von {', '.join(BOOKING_TYPES)} sein.")
        try:
            quantity = int(payload.get("quantity", 0))
        except (TypeError, ValueError) as err:
            raise ValidationError("quantity muss eine ganze Zahl sein.") from err
        if quantity == 0:
            raise ValidationError("quantity darf nicht 0 sein.")
        if booking_type in {"in", "out", "transfer"} and quantity < 0:
            raise ValidationError("quantity muss bei Zugang/Abgang positiv sein.")
        if booking_type == "correction" and quantity < 0:
            raise ValidationError("quantity muss bei der Korrektur positiv sein.")
        note = str(payload.get("note", "") or "").strip()
        unknown = set(payload) - {
            "type",
            "quantity",
            "note",
            "locationId",
            "location_id",
            "targetLocationId",
            "target_location_id",
        }
        if unknown:
            raise ValidationError(f"Unbekannte Felder: {', '.join(sorted(unknown))}")

        requested = payload.get("locationId", payload.get("location_id", ""))
        target_requested = payload.get("targetLocationId", payload.get("target_location_id", ""))

        async with self._store.lock:
            product = self._store.get_product(article_number)
            location_id = (
                self._store.require_location(str(requested))
                if requested
                else self._store.default_location_id()
            )
            target_id = ""
            if booking_type == "transfer":
                if target_requested:
                    target_id = self._store.require_location(str(target_requested))
                else:
                    ids = self._store.location_ids()
                    if len(ids) < 2:
                        raise ValidationError(
                            "Für eine Umlagerung sind zwei Lagerstätten erforderlich."
                        )
                    target_id = ids[1]
                if target_id == location_id:
                    raise ValidationError(
                        "Quelle und Ziel der Umlagerung müssen unterschiedliche Lagerstätten sein."
                    )
            elif target_requested:
                raise ValidationError("targetLocationId ist nur bei der Umlagerung erlaubt.")

            current = product.stock_for(location_id)
            if booking_type == "in":
                product.stock[location_id] = current + quantity
            elif booking_type == "out":
                product.stock[location_id] = max(0, current - quantity)
            elif booking_type == "transfer":
                moved = min(quantity, current)
                product.stock[location_id] = current - moved
                product.stock[target_id] = product.stock_for(target_id) + moved
            elif booking_type == "correction":
                product.stock[location_id] = quantity
            booking = StockBooking(
                id=secrets.token_hex(8),
                article_number=product.article_number,
                type=booking_type,
                quantity=quantity,
                note=note,
                at=to_iso(),
                ha_user_id=ha_user_id,
                location_id=location_id,
                target_location_id=target_id,
            )
            self._store.put_product(product)
            self._store.add_booking(booking)
            await self._store.async_save()
        return {"booking": booking.to_dict(), "product": product.to_dict()}

    async def async_list_bookings(self, article_number: str) -> list[dict[str, Any]]:
        self._store.get_product(article_number, include_archived=True)
        names = {item["id"]: item["name"] for item in self._store.locations()}
        bookings = sorted(
            self._store.bookings(article_number),
            key=lambda item: str(item.get("at", "")),
            reverse=True,
        )
        return [
            {
                **item,
                "locationName": names.get(str(item.get("locationId", "")), ""),
                "targetLocationName": names.get(str(item.get("targetLocationId", "")), ""),
            }
            for item in bookings
        ]

    # ------------------------------------------------------------------ Bilder
    def _sync_images(self, product: Product) -> None:
        """Genau ein Hauptbild sicherstellen (erste Datei, falls keines gesetzt ist)."""

        if not product.images:
            return
        mains = [image for image in product.images if image.is_main]
        if not mains:
            product.images[0].is_main = True
        elif len(mains) > 1:
            first = mains[0]
            for image in product.images:
                image.is_main = image is first

    async def async_list_images(self, article_number: str) -> list[dict[str, Any]]:
        product = await self.async_get(article_number, include_archived=True)
        self._sync_images(product)
        return await self.image_payloads(product)

    async def image_payloads(self, product: Product) -> list[dict[str, Any]]:
        """Bilder eines Produkts inklusive Größenmetadaten (aus den Dateien gelesen)."""

        if not product.images:
            return []
        paths = [
            self._store.images.path_for(product.article_number, image.name)
            for image in product.images
        ]
        infos = await async_inspect_paths(paths, self._store.image_max_bytes)
        return [
            {
                "name": image.name,
                "url": f"{API_PREFIX}/products/{product.article_number}/images/{image.name}",
                "is_main": image.is_main,
                **info.to_dict(),
            }
            for image, info in zip(product.images, infos, strict=True)
        ]

    async def async_serialise_product(self, product: Product) -> dict[str, Any]:
        """Produkt-Dict für die API, Bilder mit ``bytes``/``width``/``height``/``oversized``."""

        payloads = await self.async_serialise_products([product])
        return payloads[0]

    async def async_serialise_products(self, products: list[Product]) -> list[dict[str, Any]]:
        """Mehrere Produkte mit Größenmetadaten – ein Executor-Lauf für alle Bilder."""

        self._sync_images_all(products)
        paths = [
            self._store.images.path_for(product.article_number, image.name)
            for product in products
            for image in product.images
        ]
        infos = await async_inspect_paths(paths, self._store.image_max_bytes)
        payloads: list[dict[str, Any]] = []
        cursor = 0
        for product in products:
            payload = product.to_dict()
            count = len(product.images)
            payload["images"] = [
                {"name": image.name, "is_main": image.is_main, **infos[cursor + index].to_dict()}
                for index, image in enumerate(product.images)
            ]
            cursor += count
            payloads.append(payload)
        return payloads

    def _sync_images_all(self, products: list[Product]) -> None:
        for product in products:
            self._sync_images(product)

    async def async_add_image(
        self,
        article_number: str,
        *,
        filename: str,
        content_type: str,
        data: bytes,
    ) -> dict[str, Any]:
        if content_type not in ALLOWED_CONTENT_TYPES:
            raise ValidationError(
                "Nur JPEG, PNG, WebP und GIF werden unterstützt.", code="unsupported_media_type"
            )
        if not data:
            raise ValidationError("Die hochgeladene Datei ist leer.")
        if len(data) > MAX_IMAGE_BYTES:
            raise ValidationError("Das Bild ist größer als 10 MB.", code="file_too_large")

        # Grenze zuerst prüfen (billig, ohne Dekodieren); danach wird außerhalb
        # der Sperre verkleinert, damit CPU-Arbeit keine Schreibvorgänge blockiert.
        async with self._store.lock:
            product = self._store.get_product(article_number, include_archived=True)
            if len(product.images) >= MAX_IMAGES:
                raise ImageLimitError(
                    f"Maximal {MAX_IMAGES} Bilder pro Produkt. Bitte zuerst ein Bild löschen.",
                    code="image_limit",
                )
        optimized = await async_optimize_image(data, content_type, self._store.image_max_bytes)

        async with self._store.lock:
            product = self._store.get_product(article_number, include_archived=True)
            if len(product.images) >= MAX_IMAGES:
                raise ImageLimitError(
                    f"Maximal {MAX_IMAGES} Bilder pro Produkt. Bitte zuerst ein Bild löschen.",
                    code="image_limit",
                )
            existing = [image.name for image in product.images]
            base_name = next_image_name(product.article_number, existing)
            name = f"{Path(base_name).stem}{optimized.suffix}"
            written = await self._store.images.async_write(
                product.article_number, name, optimized.data
            )
            product.images.append(Image(name=name, is_main=not product.images))
            try:
                self._store.put_product(product)
                await self._store.async_save()
            except BaseException:
                await self._store.images.async_delete(product.article_number, name)
                raise
        _ = written, filename
        return {
            "images": await self.async_list_images(article_number),
            "original": optimized.original_payload(),
            "stored": optimized.stored_payload(),
            "resized": optimized.resized,
            "optimize_message": optimized.message,
        }

    async def async_delete_image(self, article_number: str, name: str) -> dict[str, Any]:
        async with self._store.lock:
            product = self._store.get_product(article_number, include_archived=True)
            _validate_image_name(product, name)
            was_main = any(image.is_main and image.name == name for image in product.images)
            product.images = [image for image in product.images if image.name != name]
            if was_main and product.images:
                product.images[0].is_main = True
            self._sync_images(product)
            self._store.put_product(product)
            await self._store.async_save()
            await self._store.images.async_delete(product.article_number, name)
        return {"images": await self.async_list_images(article_number)}

    async def async_set_image_order(self, article_number: str, order: list[str]) -> dict[str, Any]:
        async with self._store.lock:
            product = self._store.get_product(article_number, include_archived=True)
            existing = [image.name for image in product.images]
            if sorted(order) != sorted(existing) or len(set(order)) != len(order):
                raise ValidationError("order muss exakt alle vorhandenen Bildnamen enthalten.")
            by_name = {image.name: image for image in product.images}
            product.images = [by_name[name] for name in order]
            self._sync_images(product)
            self._store.put_product(product)
            await self._store.async_save()
        return {"images": await self.async_list_images(article_number)}

    async def async_set_main_image(self, article_number: str, name: str) -> dict[str, Any]:
        async with self._store.lock:
            product = self._store.get_product(article_number, include_archived=True)
            _validate_image_name(product, name)
            for image in product.images:
                image.is_main = image.name == name
            self._store.put_product(product)
            await self._store.async_save()
        return {"images": await self.async_list_images(article_number)}

    async def async_optimize_images(self, article_number: str) -> dict[str, Any]:
        """Alle zu großen Bilder eines Produkts verkleinern (idempotent).

        Reihenfolge und Hauptbild bleiben erhalten. Ändert sich durch die
        Formatwahl die Dateiendung, wird das Bild an derselben Listenposition
        umbenannt. Fehler einzelner Bilder brechen den Lauf nicht ab.
        """

        async with self._store.lock:
            product = self._store.get_product(article_number, include_archived=True)
            self._sync_images(product)
            results: list[dict[str, Any]] = []
            changed = False
            snapshot_taken = False
            bytes_before_total = 0
            bytes_after_total = 0
            for image in list(product.images):
                original_name = image.name
                path = self._store.images.path_for(product.article_number, image.name)
                before = await asyncio.to_thread(read_info_sync, path, self._store.image_max_bytes)
                bytes_before_total += before.bytes
                try:
                    raw = await asyncio.to_thread(path.read_bytes)
                    optimized = await async_optimize_image(
                        raw,
                        content_type_for_name(image.name),
                        self._store.image_max_bytes,
                    )
                except (OSError, ValidationError) as err:
                    bytes_after_total += before.bytes
                    message = (
                        err.message
                        if isinstance(err, ValidationError)
                        else "Die Bilddatei konnte nicht gelesen werden."
                    )
                    results.append(
                        {
                            "name": image.name,
                            "previous_name": original_name,
                            "before": before.to_dict(),
                            "after": before.to_dict(),
                            "resized": False,
                            "message": message,
                            "error": message,
                        }
                    )
                    continue
                stored = optimized.stored_payload()
                if optimized.resized:
                    if not snapshot_taken:
                        # Snapshot der Metadaten vor dem ersten Überschreiben.
                        await self._store.async_snapshot("pre-image-optimize")
                        snapshot_taken = True
                    new_name = f"{Path(image.name).stem}{optimized.suffix}"
                    try:
                        await self._store.images.async_write(
                            product.article_number, new_name, optimized.data
                        )
                        if new_name != image.name:
                            await self._store.images.async_delete(
                                product.article_number, image.name
                            )
                            image.name = new_name
                    except OSError as err:
                        bytes_after_total += before.bytes
                        message = f"Das Bild konnte nicht geschrieben werden: {err}"
                        results.append(
                            {
                                "name": original_name,
                                "previous_name": original_name,
                                "before": before.to_dict(),
                                "after": before.to_dict(),
                                "resized": False,
                                "message": message,
                                "error": message,
                            }
                        )
                        continue
                    changed = True
                bytes_after_total += int(stored["bytes"])
                results.append(
                    {
                        "name": image.name,
                        "previous_name": original_name,
                        "before": optimized.original_payload(),
                        "after": stored,
                        "resized": optimized.resized,
                        "message": optimized.message,
                        "error": None,
                    }
                )
            if changed:
                self._store.put_product(product)
                await self._store.async_save()
        saved_percent = (
            round((bytes_before_total - bytes_after_total) / bytes_before_total * 100, 1)
            if bytes_before_total
            else 0.0
        )
        return {
            "results": results,
            "summary": {
                "count": len(results),
                "bytes_before": bytes_before_total,
                "bytes_after": bytes_after_total,
                "saved_percent": saved_percent,
            },
            "images": await self.async_list_images(article_number),
        }

    async def async_rotate_image(
        self, article_number: str, name: str, *, direction: str
    ) -> dict[str, Any]:
        """Bild destruktiv um 90° drehen; die Originaldatei wird vorher gesichert.

        Gelesen und gedreht wird – wie beim Upload – außerhalb der Sperre. Vor
        dem Überschreiben werden Produkt und Bildname innerhalb der Sperre
        erneut geprüft, damit kein veralteter Stand geschrieben wird. Die
        Sicherung der Originaldatei liegt byteweise identisch unter
        ``backups/images/``; die Metadaten erhält ein Snapshot
        ``pre-image-rotate`` (analog zur Sammel-Optimierung).
        """

        if direction not in ROTATE_DIRECTIONS:
            raise ValidationError(ROTATE_DIRECTION_MESSAGE)
        async with self._store.lock:
            product = self._store.get_product(article_number, include_archived=True)
            _validate_image_name(product, name)
            path = self._store.images.path_for(product.article_number, name)
        try:
            original = await asyncio.to_thread(path.read_bytes)
        except OSError as err:
            raise ValidationError(
                IMAGE_ROTATE_WRITE_FAILED_MESSAGE, code="image_write_failed"
            ) from err
        rotated = await asyncio.to_thread(
            rotate_image_sync,
            original,
            direction=direction,
            content_type=content_type_for_name(name),
            max_bytes=self._store.image_max_bytes,
        )

        async with self._store.lock:
            product = self._store.get_product(article_number, include_archived=True)
            _validate_image_name(product, name)
            target = self._store.images.path_for(product.article_number, name)
            try:
                await self._async_backup_image(product.article_number, name, original)
                await self._store.async_snapshot("pre-image-rotate")
            except OSError as err:
                # Ohne Sicherung wird nicht überschrieben.
                raise ValidationError(
                    IMAGE_ROTATE_WRITE_FAILED_MESSAGE, code="image_write_failed"
                ) from err
            try:
                await self._store.images.async_write(product.article_number, name, rotated.data)
            except OSError as err:
                raise ValidationError(
                    IMAGE_ROTATE_WRITE_FAILED_MESSAGE, code="image_write_failed"
                ) from err
            metadata_cache().invalidate(target)
            try:
                self._store.put_product(product)
                await self._store.async_save()
            except BaseException:
                try:
                    await self._store.images.async_write(product.article_number, name, original)
                except OSError:  # pragma: no cover - Sicherung liegt bereits vor
                    _LOGGER.exception(
                        "Originaldatei %s konnte nach fehlgeschlagenem Speichern nicht "
                        "wiederhergestellt werden",
                        target,
                    )
                metadata_cache().invalidate(target)
                raise
        result: ImageRotateResultDict = {
            "name": name,
            "direction": direction,
            "degrees": rotated.degrees,
            "before": rotated.before_payload(),
            "after": rotated.after_payload(),
            "message": rotated.message,
        }
        return {
            "images": await self.async_list_images(article_number),
            "result": result,
        }

    async def _async_backup_image(self, article_number: str, name: str, data: bytes) -> Path:
        """Byteweise identische Kopie der Originaldatei unter ``backups/images/``."""

        # Mikrosekunden, damit zwei Drehungen kurz hintereinander die erste
        # Sicherung (das echte Original) nicht überschreiben.
        stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
        backups = ImageStorage(self._store.backup_dir / IMAGE_BACKUP_SUBDIR)
        return await backups.async_write(article_number, f"{stamp}-{name}", data)

    async def async_read_image(self, article_number: str, name: str) -> tuple[Path, str]:
        product = await self.async_get(article_number, include_archived=True)
        _validate_image_name(product, name)
        suffix = Path(name).suffix.casefold()
        content_type = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }.get(suffix, "application/octet-stream")
        return self._store.images.path_for(product.article_number, name), content_type


def _validate_image_name(product: Product, name: str) -> None:
    if Path(name).name != name:
        raise ValidationError("Ungültiger Bildname.")
    if name not in {image.name for image in product.images}:
        raise NotFoundError(f"Bild {name} nicht gefunden.")


__all__ = [
    "SORT_KEYS",
    "ProductFilter",
    "ProductService",
    "generate_article_number",
    "product_matches",
    "sort_products",
    "StoreError",
]
