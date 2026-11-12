/**
 * Drehen von Produktbildern im Tab „Bilder“.
 *
 * Bewusst frei von Lit- und DOM-Abhängigkeiten, damit Auswahlregeln und
 * Beschriftungen ohne Browser testbar bleiben (`node --test`). Die deutschen
 * Texte bleiben hier, weil das Panel keine Übersetzungsschlüssel für
 * Bildaktionen besitzt.
 *
 * Vertrag des Servers: `direction` ist `left` (90° gegen den Uhrzeigersinn)
 * oder `right` (90° im Uhrzeigersinn).
 */

export const ROTATE_LEFT = "left";
export const ROTATE_RIGHT = "right";

/** Reihenfolge der beiden Knöpfe in der Bildkarte. */
export const ROTATE_DIRECTIONS = Object.freeze([ROTATE_LEFT, ROTATE_RIGHT]);

const ROTATE_META = Object.freeze({
  [ROTATE_LEFT]: Object.freeze({
    direction: ROTATE_LEFT,
    degrees: -90,
    arrow: "↺",
    ariaText: "gegen den Uhrzeigersinn",
    noticeText: "nach links",
  }),
  [ROTATE_RIGHT]: Object.freeze({
    direction: ROTATE_RIGHT,
    degrees: 90,
    arrow: "↻",
    ariaText: "im Uhrzeigersinn",
    noticeText: "nach rechts",
  }),
});

/** Metadaten einer Richtung oder `null` bei unbekannten Werten. */
export const rotateMeta = (direction) =>
  typeof direction === "string" && Object.hasOwn(ROTATE_META, direction)
    ? ROTATE_META[direction]
    : null;

export const isRotateDirection = (direction) => rotateMeta(direction) !== null;

/** Liefert die gültige Richtung oder `""`; niemals einen fremden Wert. */
export const normalizeRotateDirection = (direction) => (isRotateDirection(direction) ? direction : "");

/**
 * Darf dieses Bild gedreht werden? Animierte Bilder (GIF/animiertes WebP) kann
 * Pillow nicht verlustfrei drehen, deshalb ist der Knopf dort deaktiviert —
 * der Server würde mit `409 image_animated` antworten.
 *
 * `mode` ist der Dialogmodus (`edit`/`create`), `busy` der Sammelstatus des
 * Bilder-Tabs (`imagesBusy`, `imagesLoading`, `imagesOptimizeBusy`).
 */
export const canRotateImage = (image, { mode, busy } = {}) => {
  if (!image || typeof image !== "object") {
    return false;
  }
  if (mode !== "edit" || busy) {
    return false;
  }
  if (image.animated === true) {
    return false;
  }
  return typeof image.name === "string" && image.name.length > 0;
};

/** Kurzname für Aufrufer, die nur die Regel prüfen wollen. */
export const canRotate = canRotateImage;

/** Kurzbeschriftung im Knopf, z. B. „↺ 90°“. */
export const rotateButtonLabel = (direction) => {
  const meta = rotateMeta(direction);
  return meta ? `${meta.arrow} 90°` : "";
};

/** `aria-label` des Knopfes; `position` ist die 1-basierte Bildnummer. */
export const rotateAriaLabel = (position, direction) => {
  const meta = rotateMeta(direction);
  const index = Math.trunc(Number(position));
  if (!meta || !Number.isFinite(index) || index < 1) {
    return "";
  }
  return `Bild ${index} um 90° ${meta.ariaText} drehen`;
};

/** Erfolgsmeldung nach dem Drehen, z. B. „Bild wurde um 90° nach links gedreht.“ */
export const rotateNoticeText = (direction) => {
  const meta = rotateMeta(direction);
  return meta ? `Bild wurde um 90° ${meta.noticeText} gedreht.` : "";
};

const escapeAttributeValue = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * Selektor für den Fokus nach dem Re-Render: deaktivierte Knöpfe verlieren den
 * Fokus, deshalb wird derselbe Knopf über Bildname und Richtung gesucht.
 */
export const rotateTargetSelector = (name, direction) => {
  if (!name || !isRotateDirection(direction)) {
    return "";
  }
  return `[data-image="${escapeAttributeValue(name)}"][data-direction="${direction}"]`;
};
