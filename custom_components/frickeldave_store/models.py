"""Domänenmodelle und Validierung für ``frickeldave_store``.

Die Modelle sind bewusst frei von Home-Assistant-Abhängigkeiten, damit sie in
reinen Domain-Tests und im Export-CLI ohne HA-Laufzeit verwendet werden können.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final, TypedDict

SCHEMA_VERSION: Final = 2
CATEGORIES: Final[tuple[str, ...]] = ("3D", "EP", "LA", "SB", "WO")
CATEGORY_LABELS: Final[dict[str, str]] = {
    "3D": "3D-Druck",
    "EP": "Epoxidharz",
    "LA": "Laser",
    "SB": "Steinmasse",
    "WO": "Holz",
}
MAX_IMAGES: Final = 10

#: Lagerstätten: IDs bleiben beim Umbenennen stabil, damit Bestände erhalten bleiben.
#: Reihenfolge ist fachlich relevant: die erste Lagerstätte wird im Website-Export
#: zu ``stock``, die zweite zu ``salesCabinet``.
DEFAULT_LOCATIONS: Final[tuple[tuple[str, str], ...]] = (
    ("lager", "Lager"),
    ("verkaufsschrank", "Verkaufsschrank"),
)
MAX_LOCATIONS: Final = 20
LOCATION_NAME_MAX_LENGTH: Final = 40
LOCATION_ID_MAX_LENGTH: Final = 40
LOCATION_ID_RE: Final = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")

ARTICLE_NUMBER_LENGTH: Final = 6
ARTICLE_NUMBER_RE: Final = re.compile(r"^[A-Z0-9]{6}$")
BOOKING_TYPES: Final[tuple[str, ...]] = ("in", "out", "transfer", "correction")
VISIBILITY_VALUES: Final[tuple[str, ...]] = ("visible", "invisible")
IMAGE_SUFFIXES: Final[tuple[str, ...]] = (".jpg", ".jpeg", ".png", ".webp", ".gif")

PRODUCT_FIELDS: Final[tuple[str, ...]] = (
    "articleNumber",
    "name",
    "description",
    "category",
    "price",
    "size",
    "tags",
    "customizable",
    "visible",
    "stock",
    "salesCabinet",
    "images",
    "archived",
    "createdAt",
    "updatedAt",
    "schemaVersion",
)

#: Felder, die vom Client geschrieben werden dürfen.
WRITABLE_FIELDS: Final[tuple[str, ...]] = (
    "name",
    "description",
    "price",
    "size",
    "tags",
    "customizable",
    "visible",
    "stock",
    "salesCabinet",
)


class StoreError(Exception):
    """Basisklasse aller fachlichen Fehler mit stabilem Fehlercode."""

    code: str = "error"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code

    @property
    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


class ValidationError(StoreError):
    """Ungültige Eingabedaten."""

    code = "validation_error"


class NotFoundError(StoreError):
    """Angefragtes Objekt existiert nicht."""

    code = "not_found"


class ConflictError(StoreError):
    """Konflikt mit bestehenden Daten (z. B. doppelte Artikelnummer)."""

    code = "conflict"


class ImageLimitError(StoreError):
    """Mehr als zehn Bilder pro Produkt."""

    code = "image_limit"


class NotAuthenticated(StoreError):
    """Die Anfrage trägt keine (mehr gültige) HA-Sitzung."""

    code = "not_authenticated"


class PermissionDenied(StoreError):
    """Default Deny: keine ausreichende Rolle."""

    code = "forbidden"


def utc_now() -> datetime:
    """Aktuelle UTC-Zeit (sekundengenau)."""

    return datetime.now(UTC).replace(microsecond=0)


def to_iso(moment: datetime | None = None) -> str:
    """Zeitstempel im ISO-8601-Format mit ``Z``-Suffix."""

    value = (moment or utc_now()).astimezone(UTC)
    return value.isoformat().replace("+00:00", "Z")


def normalise_tags(values: Any) -> list[str]:
    """Tags trimmen, leere entfernen und case-insensitiv deduplizieren."""

    if values is None:
        return []
    if isinstance(values, str):
        values = values.split(",")
    if not isinstance(values, (list, tuple, set)):
        raise ValidationError("Tags müssen eine Liste von Zeichenketten sein.")
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        if not isinstance(raw, str):
            raise ValidationError("Tags müssen Zeichenketten sein.")
        tag = " ".join(raw.split())
        if not tag:
            continue
        key = tag.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(tag)
    return result


def normalise_price(value: Any) -> float:
    """Preis als Dezimalzahl (EUR), nie negativ."""

    if isinstance(value, bool):
        raise ValidationError("Preis muss eine Zahl sein.")
    try:
        price = round(float(value), 2)
    except (TypeError, ValueError) as err:
        raise ValidationError("Preis muss eine Zahl sein.") from err
    if price < 0:
        raise ValidationError("Preis darf nicht negativ sein.")
    if price > 1_000_000:
        raise ValidationError("Preis ist unrealistisch hoch.")
    return price


def normalise_stock(value: Any, field_name: str) -> int:
    """Bestand als ganze Zahl ≥ 0."""

    if isinstance(value, bool):
        raise ValidationError(f"{field_name} muss eine ganze Zahl sein.")
    try:
        stock = int(value)
    except (TypeError, ValueError) as err:
        raise ValidationError(f"{field_name} muss eine ganze Zahl sein.") from err
    if stock < 0:
        raise ValidationError(f"{field_name} darf nicht negativ sein.")
    return stock


def default_locations() -> list[dict[str, str]]:
    """Standard-Lagerstätten (heutiges Verhalten: Lager und Verkaufsschrank)."""

    return [{"id": location_id, "name": name} for location_id, name in DEFAULT_LOCATIONS]


def default_location_ids() -> list[str]:
    return [location_id for location_id, _ in DEFAULT_LOCATIONS]


def normalise_location_name(value: Any) -> str:
    """Name einer Lagerstätte: nicht leer, sinnvoll begrenzt."""

    if value is None or not isinstance(value, str):
        raise ValidationError("Der Name einer Lagerstätte muss eine Zeichenkette sein.")
    if len(" ".join(value.split())) > LOCATION_NAME_MAX_LENGTH:
        raise ValidationError(
            f"Der Name einer Lagerstätte ist zu lang (max. {LOCATION_NAME_MAX_LENGTH} Zeichen)."
        )
    name = " ".join(value.split())
    if not name:
        raise ValidationError("Der Name einer Lagerstätte darf nicht leer sein.")
    return name


def location_slug(name: str) -> str:
    """Stabile ID aus dem Namen (Umlaute transliteriert, sonst ASCII-Slug)."""

    text = name.casefold()
    for source, target in {"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"}.items():
        text = text.replace(source, target)
    slug = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return (slug or "lager")[: LOCATION_ID_MAX_LENGTH - 4]


def _unique_location_id(base: str, used: set[str]) -> str:
    candidate = base
    counter = 2
    while candidate in used:
        candidate = f"{base}-{counter}"
        counter += 1
    return candidate


def validate_locations(
    entries: Any,
    *,
    existing_ids: list[str] | None = None,
    match_by: str = "id",
) -> list[dict[str, str]]:
    """Lagerstätten validieren und IDs zuordnen.

    ``match_by="id"`` (Konfigurationspanel): ``id`` ist optional, fehlt sie, wird
    eine neue Lagerstätte angelegt. ``match_by="position"`` (Options-Flow, eine
    Zeile pro Lagerstätte): Eintrag *n* übernimmt die ID des bisherigen Eintrags *n*
    und benennt ihn damit um, statt Bestände zu verlieren.
    """

    if match_by not in {"id", "position"}:
        raise ValidationError("match_by muss 'id' oder 'position' sein.")
    # ``existing_ids=None`` heißt: gespeicherte IDs sind nicht auf einen Bestand
    # beschränkt (Laden/Migration). Beim Ändern übergibt der Store seine IDs.
    unrestricted = existing_ids is None
    existing = list(existing_ids or [])
    if isinstance(entries, str):
        entries = entries.splitlines()
    if not isinstance(entries, (list, tuple)):
        raise ValidationError("locations muss eine Liste von Lagerstätten sein.")
    if not entries:
        raise ValidationError("Mindestens eine Lagerstätte ist erforderlich.")
    if len(entries) > MAX_LOCATIONS:
        raise ValidationError(f"Maximal {MAX_LOCATIONS} Lagerstätten sind möglich.")

    result: list[dict[str, str]] = []
    used_ids: set[str] = set()
    seen_names: set[str] = set()
    for index, raw in enumerate(entries):
        if isinstance(raw, str):
            raw = {"name": raw}
        if not isinstance(raw, dict):
            raise ValidationError("Jede Lagerstätte muss ein Objekt mit 'name' sein.")
        unknown = set(raw) - {"id", "name"}
        if unknown:
            raise ValidationError(f"Unbekannte Felder: {', '.join(sorted(unknown))}")
        name = normalise_location_name(raw.get("name"))
        key = name.casefold()
        if key in seen_names:
            raise ValidationError(
                f"Der Name „{name}“ wird mehrfach verwendet. Bitte eindeutige Namen wählen."
            )
        seen_names.add(key)

        requested = str(raw.get("id") or "").strip()
        if requested:
            if unrestricted:
                if not LOCATION_ID_RE.match(requested):
                    raise ValidationError(f"Ungültige Lagerstätten-ID: {requested!r}.")
            elif requested not in existing:
                raise ValidationError(f"Unbekannte Lagerstätte: {requested!r}.")
            location_id = requested
        elif match_by == "position" and index < len(existing):
            location_id = existing[index]
        else:
            location_id = _unique_location_id(location_slug(name), used_ids | set(existing))
        if location_id in used_ids:
            raise ValidationError(f"Die Lagerstätte {location_id!r} ist doppelt angegeben.")
        used_ids.add(location_id)
        result.append({"id": location_id, "name": name})
    return result


def location_totals(products: Any, location_id: str) -> tuple[int, int]:
    """Anzahl Produkte mit Bestand > 0 und Summe der Stücke für eine Lagerstätte."""

    affected = 0
    pieces = 0
    for product in products:
        stock = product.stock if isinstance(product, Product) else product.get("stock", {})
        if not isinstance(stock, dict):
            continue
        quantity = int(stock.get(location_id, 0) or 0)
        if quantity > 0:
            affected += 1
            pieces += quantity
    return affected, pieces


def normalise_stock_map(
    value: Any,
    location_ids: list[str],
    *,
    field_name: str = "stock",
    strict: bool = True,
    fill_missing: bool = True,
) -> dict[str, int]:
    """Bestände als Zuordnung Lagerstätten-ID → Stückzahl lesen.

    Ältere Daten (und die Website) kennen ``stock``/``salesCabinet`` als einzelne
    Zahlen. Eine Zahl bei ``stock`` gilt als Bestand der ersten Lagerstätte.
    """

    result: dict[str, int] = {}
    if fill_missing:
        result = {location_id: 0 for location_id in location_ids}
    if value is None:
        return result
    if isinstance(value, dict):
        for raw_key, raw_value in value.items():
            key = str(raw_key)
            if key not in location_ids:
                if strict:
                    raise ValidationError(f"Unbekannte Lagerstätte: {key!r}.")
                result[key] = normalise_stock(raw_value, f"{field_name}.{key}")
                continue
            result[key] = normalise_stock(raw_value, f"{field_name}.{key}")
        return result
    if isinstance(value, (list, tuple, set)):
        raise ValidationError(f"{field_name} muss eine Zuordnung von Lagerstätten sein.")
    if not location_ids:
        raise ValidationError("Es ist keine Lagerstätte konfiguriert.")
    result[location_ids[0]] = normalise_stock(value, field_name)
    return result


def normalise_bool(value: Any) -> bool:
    """Boolesche Werte tolerant aus JSON/Query-Parametern lesen."""

    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().casefold()
        if lowered in {"1", "true", "yes", "ja", "on"}:
            return True
        if lowered in {"0", "false", "no", "nein", "off"}:
            return False
    raise ValidationError(f"Ungültiger Wahrheitswert: {value!r}")


def normalise_text(value: Any, field_name: str, *, max_length: int = 20_000) -> str:
    """Textfeld trimmen und Länge begrenzen."""

    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValidationError(f"{field_name} muss eine Zeichenkette sein.")
    text = value.strip()
    if len(text) > max_length:
        raise ValidationError(f"{field_name} ist zu lang (max. {max_length} Zeichen).")
    return text


@dataclass(slots=True)
class Image:
    """Bilddatei eines Produkts."""

    name: str
    is_main: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "is_main": self.is_main}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Image:
        return cls(name=str(data.get("name", "")), is_main=bool(data.get("is_main", False)))


class ImageSizeDict(TypedDict):
    """Größenmetadaten eines Bildes (``before``/``after`` der Drehung)."""

    bytes: int
    width: int | None
    height: int | None
    content_type: str
    oversized: bool


class ImageRotateResultDict(TypedDict):
    """Antwort von ``POST .../images/{name}/rotate`` (Issue #322)."""

    name: str
    direction: str
    degrees: int
    before: ImageSizeDict
    after: ImageSizeDict
    message: str


@dataclass(slots=True)
class Product:
    """Produkt der Lagerverwaltung (Schema-Version 2: Bestand je Lagerstätte)."""

    article_number: str
    name: str
    category: str
    price: float = 0.0
    description: str = ""
    size: str = ""
    tags: list[str] = field(default_factory=list)
    customizable: bool = True
    visible: bool = True
    #: Bestand je Lagerstätten-ID, z. B. ``{"lager": 3, "verkaufsschrank": 1}``.
    stock: dict[str, int] = field(default_factory=dict)
    images: list[Image] = field(default_factory=list)
    archived: bool = False
    created_at: str = ""
    updated_at: str = ""
    schema_version: int = SCHEMA_VERSION

    @property
    def main_image(self) -> Image | None:
        for image in self.images:
            if image.is_main:
                return image
        return self.images[0] if self.images else None

    def stock_for(self, location_id: str) -> int:
        return int(self.stock.get(location_id, 0) or 0)

    def total_stock(self) -> int:
        return sum(int(value or 0) for value in self.stock.values())

    def to_dict(self) -> dict[str, Any]:
        return {
            "articleNumber": self.article_number,
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "price": self.price,
            "size": self.size,
            "tags": list(self.tags),
            "customizable": self.customizable,
            "visible": self.visible,
            "stock": {key: int(value) for key, value in self.stock.items()},
            "images": [image.to_dict() for image in self.images],
            "archived": self.archived,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "schemaVersion": self.schema_version,
        }

    @classmethod
    def from_dict(
        cls,
        data: dict[str, Any],
        *,
        location_ids: list[str] | None = None,
        strict: bool = True,
    ) -> Product:
        """Tolerant lesen – ältere Katalogdaten haben weder Bilder noch Zeitstempel.

        Ohne ``location_ids`` gelten die Standard-Lagerstätten. Eine einzelne Zahl
        in ``stock`` (Website-Import, Schema 1) wird der ersten Lagerstätte
        zugeordnet, ``salesCabinet`` der zweiten.
        """

        article_number = str(data.get("articleNumber", "")).upper()
        category = str(data.get("category", "")).upper()
        if category not in CATEGORIES:
            raise ValidationError(f"Unbekannte Kategorie: {category!r}")
        images = [Image.from_dict(item) for item in data.get("images", []) or []]
        if len(images) > MAX_IMAGES:
            images = images[:MAX_IMAGES]
        ids = list(location_ids or default_location_ids())
        stock = normalise_stock_map(
            data.get("stock"), ids, field_name="stock", strict=strict, fill_missing=True
        )
        cabinet = data.get("salesCabinet")
        if cabinet is not None and len(ids) > 1:
            raw_stock = data.get("stock")
            already_mapped = isinstance(raw_stock, dict) and ids[1] in {
                str(key) for key in raw_stock
            }
            if not already_mapped:
                stock[ids[1]] = normalise_stock(cabinet, "salesCabinet")
        return cls(
            article_number=article_number,
            name=str(data.get("name", "")),
            category=category,
            price=normalise_price(data.get("price", 0)),
            description=str(data.get("description", "") or ""),
            size=str(data.get("size", "") or ""),
            tags=normalise_tags(data.get("tags", [])),
            customizable=bool(data.get("customizable", True)),
            visible=bool(data.get("visible", True)),
            stock=stock,
            images=images,
            archived=bool(data.get("archived", False)),
            created_at=str(data.get("createdAt", "") or ""),
            updated_at=str(data.get("updatedAt", "") or ""),
            schema_version=int(data.get("schemaVersion", SCHEMA_VERSION)),
        )


@dataclass(slots=True)
class StockBooking:
    """Bestandsbuchung (Zugang, Abgang, Umlagerung, Korrektur) je Lagerstätte."""

    id: str
    article_number: str
    type: str
    quantity: int
    note: str = ""
    at: str = ""
    ha_user_id: str = ""
    #: Betroffene Lagerstätte; bei ``transfer`` die Quelle.
    location_id: str = ""
    #: Nur bei ``transfer``: Ziel-Lagerstätte.
    target_location_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "articleNumber": self.article_number,
            "type": self.type,
            "quantity": self.quantity,
            "note": self.note,
            "at": self.at,
            "ha_user_id": self.ha_user_id,
            "locationId": self.location_id,
            "targetLocationId": self.target_location_id,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> StockBooking:
        return cls(
            id=str(data.get("id", "")),
            article_number=str(data.get("articleNumber", "")),
            type=str(data.get("type", "correction")),
            quantity=int(data.get("quantity", 0)),
            note=str(data.get("note", "") or ""),
            at=str(data.get("at", "") or ""),
            ha_user_id=str(data.get("ha_user_id", "") or ""),
            location_id=str(data.get("locationId", "") or ""),
            target_location_id=str(data.get("targetLocationId", "") or ""),
        )


def validate_create_payload(
    payload: dict[str, Any], *, location_ids: list[str] | None = None
) -> dict[str, Any]:
    """Eingaben für ein neues Produkt prüfen und normalisieren."""

    if not isinstance(payload, dict):
        raise ValidationError("Anfragekörper muss ein JSON-Objekt sein.")

    name = normalise_text(payload.get("name"), "name", max_length=200)
    if not name:
        raise ValidationError("Name ist ein Pflichtfeld.")

    category = str(payload.get("category", "")).upper().strip()
    if category not in CATEGORIES:
        allowed = ", ".join(CATEGORIES)
        raise ValidationError(f"Kategorie muss eine von {allowed} sein.")

    ids = list(location_ids or default_location_ids())
    stock = normalise_stock_map(payload.get("stock"), ids, field_name="stock")
    if payload.get("salesCabinet") is not None and len(ids) > 1:
        stock[ids[1]] = normalise_stock(payload.get("salesCabinet"), "salesCabinet")

    return {
        "name": name,
        "category": category,
        "description": normalise_text(payload.get("description"), "description"),
        "price": normalise_price(payload.get("price", 0)),
        "size": normalise_text(payload.get("size"), "size", max_length=200),
        "tags": normalise_tags(payload.get("tags", [])),
        "customizable": normalise_bool(payload.get("customizable", True)),
        "visible": normalise_bool(payload.get("visible", True)),
        "stock": stock,
    }


def validate_update_payload(
    payload: dict[str, Any],
    *,
    immutable_category: str,
    location_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Eingaben für ein Produktupdate prüfen; Kategorie und Artikelnummer sind unveränderlich."""

    if not isinstance(payload, dict):
        raise ValidationError("Anfragekörper muss ein JSON-Objekt sein.")

    if "articleNumber" in payload:
        raise ValidationError("Die Artikelnummer ist unveränderlich.")
    if "category" in payload:
        requested = str(payload.get("category", "")).upper().strip()
        if requested != immutable_category:
            raise ValidationError(
                "Die Kategorie ist nach dem Anlegen unveränderlich. "
                "Bitte ein neues Produkt anlegen.",
                code="category_immutable",
            )

    changes: dict[str, Any] = {}
    if "name" in payload:
        name = normalise_text(payload.get("name"), "name", max_length=200)
        if not name:
            raise ValidationError("Name darf nicht leer sein.")
        changes["name"] = name
    if "description" in payload:
        changes["description"] = normalise_text(payload.get("description"), "description")
    if "price" in payload:
        changes["price"] = normalise_price(payload.get("price"))
    if "size" in payload:
        changes["size"] = normalise_text(payload.get("size"), "size", max_length=200)
    if "tags" in payload:
        changes["tags"] = normalise_tags(payload.get("tags"))
    if "customizable" in payload:
        changes["customizable"] = normalise_bool(payload.get("customizable"))
    if "visible" in payload:
        changes["visible"] = normalise_bool(payload.get("visible"))
    ids = list(location_ids or default_location_ids())
    if "stock" in payload:
        # Teil-Update: nur die übergebenen Lagerstätten ändern sich.
        changes["stock"] = normalise_stock_map(
            payload.get("stock"), ids, field_name="stock", fill_missing=False
        )
    if "salesCabinet" in payload:
        if len(ids) < 2:
            raise ValidationError("salesCabinet ist nur mit mindestens zwei Lagerstätten möglich.")
        partial = changes.setdefault("stock", {})
        partial[ids[1]] = normalise_stock(payload.get("salesCabinet"), "salesCabinet")

    unknown = {
        key
        for key in payload
        if key
        not in {
            *WRITABLE_FIELDS,
            "articleNumber",
            "category",
            "archived",
            "images",
            "createdAt",
            "updatedAt",
            "schemaVersion",
        }
    }
    if unknown:
        raise ValidationError(f"Unbekannte Felder: {', '.join(sorted(unknown))}")
    if "archived" in payload:
        raise ValidationError(
            "Archivierung erfolgt ausschließlich über den Archiv-Endpunkt.",
            code="archive_endpoint_required",
        )
    return changes


def next_image_name(article_number: str, existing: list[str]) -> str:
    """Nächste freie Bilddatei ``<artikelnummer>-NN.jpg``."""

    used: set[int] = set()
    for name in existing:
        match = re.search(r"-(\d{2})\.[A-Za-z]+$", name)
        if match:
            used.add(int(match.group(1)))
    for number in range(1, 100):
        if number not in used:
            return f"{article_number}-{number:02d}.jpg"
    raise ImageLimitError("Kein freier Bildname mehr verfügbar.", code="image_limit")
