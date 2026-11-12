"""Regressionstests für die statischen Frontend-Assets des Panels.

Das Panel wird von ``panel_custom`` direkt als ES-Modul importiert. Ein nackter
Spezifizierer wie ``from "lit"`` lässt sich im Browser nicht auflösen, weil Home
Assistant keine Import-Map ausliefert. Lit muss deshalb als vendored Bundle
neben dem Panel liegen.

Zusätzlich sichern strukturelle Prüfungen die statischen Verträge des
Kamera-Capture-Controls im Bilder-Tab (Issue #321), ohne dafür einen
Browser-Harness einzuführen.
"""

from __future__ import annotations

import re
from pathlib import Path

FRONTEND_DIR = (
    Path(__file__).resolve().parents[1] / "custom_components" / "frickeldave_store" / "frontend"
)
PANEL_PATH = FRONTEND_DIR / "frickeldave-store-panel.js"
LIT_PATH = FRONTEND_DIR / "lit.js"

_FROM_RE = re.compile(
    r"""^\s*(?:import|export)\b[^;\n]*?\bfrom\s*(?P<quote>["'])(?P<specifier>[^"']+)(?P=quote)""",
    re.MULTILINE,
)
_SIDE_EFFECT_RE = re.compile(
    r"""^\s*import\s*(?P<quote>["'])(?P<specifier>[^"']+)(?P=quote)""",
    re.MULTILINE,
)
_EXPORT_BLOCK_RE = re.compile(r"export\s*\{([^}]*)\}")


def _module_specifiers(source: str) -> list[str]:
    return [match.group("specifier") for match in _FROM_RE.finditer(source)] + [
        match.group("specifier") for match in _SIDE_EFFECT_RE.finditer(source)
    ]


def _exported_names(code: str) -> set[str]:
    names: set[str] = set()
    for block in _EXPORT_BLOCK_RE.findall(code):
        for entry in block.split(","):
            entry = entry.strip()
            if entry:
                names.add(entry.split()[-1])
    return names


def test_panel_uses_only_relative_or_absolute_imports() -> None:
    source = PANEL_PATH.read_text(encoding="utf-8")
    specifiers = _module_specifiers(source)

    assert specifiers, "Das Panel sollte mindestens ./lit.js importieren."
    bare = [item for item in specifiers if not item.startswith(("./", "../", "/"))]
    assert not bare, (
        "Nackte Modulspezifizierer lassen sich im Browser nicht auflösen "
        f"(Home Assistant liefert keine Import-Map): {bare}"
    )
    assert "./lit.js" in specifiers


def test_lit_bundle_exists_and_exports_lit_element() -> None:
    assert LIT_PATH.is_file(), (
        "frontend/lit.js fehlt. Bitte `npm ci && npm run build:frontend` ausführen."
    )
    code = LIT_PATH.read_text(encoding="utf-8")
    assert code.strip(), "frontend/lit.js ist leer."
    assert "@license" in code and "BSD-3-Clause" in code, "Lit-Lizenzbanner fehlt."
    exports = _exported_names(code)
    assert {"LitElement", "html", "css"} <= exports, f"Unerwartete Lit-Exports: {exports}"


def _publish_button(source: str, target: str) -> str:
    match = re.search(rf'_openPublish\("{target}"\).*?</button>', source, re.DOTALL)
    assert match, f"Button für die Veröffentlichung nach {target} nicht gefunden."
    return match.group(0)


def test_publish_buttons_share_icon_and_differ_by_badge() -> None:
    source = PANEL_PATH.read_text(encoding="utf-8")
    buttons = {"dev": _publish_button(source, "dev"), "prod": _publish_button(source, "prod")}

    icons = {}
    for target, button in buttons.items():
        icon = re.search(r'<path\s+d="([^"]+)"', button)
        assert icon, f"Der {target}-Button hat kein Symbol."
        icons[target] = icon.group(1)
    assert icons["dev"] == icons["prod"], (
        "Beide Veröffentlichungs-Buttons müssen dasselbe Symbol zeigen."
    )

    for target, badge_text, label in (("dev", "dev", "dev"), ("prod", "prd", "prod")):
        button = buttons[target]
        badge = re.search(r'<span class="fd-bar-badge" aria-hidden="true">([^<]*)</span>', button)
        assert badge, f"Der {target}-Button braucht ein Badge."
        assert badge.group(1) == badge_text
        assert f'aria-label="Nach {label} veröffentlichen"' in button
        assert f'"Nach {label} veröffentlichen"' in button


# ------------------------------------------------------------ Kamera-Aufnahme (Issue #321)


def _capture_input_element(source: str) -> str:
    """Vollständiges ``<input id="fd-image-capture" … />``-Element als Rohtext."""

    start = re.search(r"""<input\b[^>]*?\bid=["']fd-image-capture["']""", source)
    assert start, "Das Capture-Input #fd-image-capture fehlt im Bilder-Tab."

    # Attributwerte enthalten ``>`` (Lit-Ausdrücke) — Klammerung zählen statt am ``/>`` schneiden.
    depth = 0
    for index in range(start.start(), len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        elif char == ">" and depth == 0:
            return source[start.start() : index + 1]
    raise AssertionError("Das Capture-Input ist nicht abgeschlossen.")


#: Mikrotexte aus der Spezifikation. ``${MAX_IMAGES}`` wird zur Laufzeit zu ``10``.
_CAPTURE_MICROTEXTS = [
    "Foto aufnehmen",
    "Ein Foto pro Aufnahme, bis zu 10 Bilder je Produkt.",
    "Die maximale Anzahl ist erreicht. Bitte zuerst ein Bild löschen.",
    "Es wurde kein Foto aufgenommen.",
    "Kamera nicht verfügbar. Bitte die Kamera-Berechtigung der Home-Assistant-App in den "
    "Systemeinstellungen prüfen.",
    "Dieses Bildformat wird nicht unterstützt. Bitte ein Foto aufnehmen oder als JPEG hochladen.",
]


def _balanced_block(source: str, open_index: int) -> str:
    """Inhalt zwischen ``source[open_index]`` (``{``) und der zugehörigen ``}``."""

    depth = 0
    for index in range(open_index, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[open_index + 1 : index]
    raise AssertionError("Unbalancierte Klammern im Panel-Quelltext.")


def _method_body(source: str, name: str) -> str:
    match = re.search(rf"\b{name}\s*\([^)]*\)\s*\{{", source)
    assert match, f"Methode {name} fehlt im Panel-Quelltext."
    return _balanced_block(source, match.end() - 1)


def _strip_js_comments(code: str) -> str:
    without_block = re.sub(r"/\*.*?\*/", "", code, flags=re.DOTALL)
    return re.sub(r"//[^\n]*", "", without_block)


def test_capture_input_targets_camera_and_accepts_single_photo() -> None:
    element = _capture_input_element(PANEL_PATH.read_text(encoding="utf-8"))

    assert re.search(r"""\btype=["']file["']""", element)
    assert re.search(r"""\bcapture=["']environment["']""", element), (
        'Ohne capture="environment" öffnet das Input den Datei-/Galerie-Dialog statt der Kamera.'
    )
    assert re.search(r"""\baccept=["']image/jpeg,image/png,image/webp,image/gif["']""", element)
    assert not re.search(r"\bmultiple\b", element), (
        "Das Capture-Input darf kein `multiple` tragen: Die Kamera liefert genau ein Foto."
    )


def test_capture_control_is_hidden_unless_pointer_is_coarse() -> None:
    source = PANEL_PATH.read_text(encoding="utf-8")
    media = re.search(r"@media\s*\(\s*pointer\s*:\s*coarse\s*\)\s*\{", source)

    assert media, "Die Sichtbarkeitsregel @media (pointer: coarse) für .fd-capture fehlt."
    block = _balanced_block(source, media.end() - 1)
    assert re.search(r"\.fd-capture\s*\{[^}]*\bdisplay\s*:\s*flex\b", block), (
        "Innerhalb von @media (pointer: coarse) muss .fd-capture sichtbar werden."
    )

    default_scope = source[: media.start()] + source[media.end() + len(block) + 1 :]
    assert re.search(r"\.fd-capture\s*\{[^}]*\bdisplay\s*:\s*none\b", default_scope), (
        "Ohne primären Touch-Pointer muss .fd-capture per `display: none` unsichtbar bleiben."
    )


def test_capture_handler_resets_input_and_avoids_data_transfer() -> None:
    source = PANEL_PATH.read_text(encoding="utf-8")
    body = _method_body(source, "_onCaptureSelected")

    assert re.search(r"""input\.value\s*=\s*(""|'')""", body), (
        'Ohne `input.value = ""` feuert `change` für ein zweites Foto gleichen Namens nicht.'
    )
    assert not re.search(r"\bDataTransfer\b", _strip_js_comments(body)), (
        "Kein DataTransfer verwenden: ältere WKWebView-Versionen können daraus "
        "keine FileList bauen."
    )


def test_capture_microtexts_exist_verbatim() -> None:
    # Benachbarte String-Literale zusammenziehen, damit Zeilenumbrüche im Quelltext nicht stören.
    text = PANEL_PATH.read_text(encoding="utf-8").replace("${MAX_IMAGES}", "10")
    text = re.sub(r'"\s*\+\s*"', "", text)

    missing = [item for item in _CAPTURE_MICROTEXTS if item not in text]
    assert not missing, f"Mikrotexte fehlen oder weichen ab: {missing}"
