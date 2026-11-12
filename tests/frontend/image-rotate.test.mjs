import assert from "node:assert/strict";
import test from "node:test";

import {
  ROTATE_DIRECTIONS,
  ROTATE_LEFT,
  ROTATE_RIGHT,
  canRotate,
  canRotateImage,
  isRotateDirection,
  normalizeRotateDirection,
  rotateAriaLabel,
  rotateButtonLabel,
  rotateMeta,
  rotateNoticeText,
  rotateTargetSelector,
} from "../../custom_components/frickeldave_store/frontend/image-rotate.js";

const EDIT = Object.freeze({ mode: "edit", busy: false });

test("rotate directions follow the server contract", () => {
  assert.equal(ROTATE_LEFT, "left");
  assert.equal(ROTATE_RIGHT, "right");
  assert.deepEqual([...ROTATE_DIRECTIONS], ["left", "right"]);
  assert.ok(Object.isFrozen(ROTATE_DIRECTIONS));
});

test("rotateMeta describes both directions in German", () => {
  assert.deepEqual(rotateMeta("left"), {
    direction: "left",
    degrees: -90,
    arrow: "↺",
    ariaText: "gegen den Uhrzeigersinn",
    noticeText: "nach links",
  });
  assert.equal(rotateMeta("right").degrees, 90);
  assert.equal(rotateMeta("right").arrow, "↻");
  assert.equal(rotateMeta("right").ariaText, "im Uhrzeigersinn");
  assert.equal(rotateMeta("right").noticeText, "nach rechts");
});

test("rotateMeta rejects unknown and non-string values", () => {
  for (const value of ["up", "", "Left", null, undefined, 90, {}, ["left"]]) {
    assert.equal(rotateMeta(value), null);
  }
});

test("isRotateDirection only accepts left and right", () => {
  assert.equal(isRotateDirection("left"), true);
  assert.equal(isRotateDirection("right"), true);
  assert.equal(isRotateDirection("LEFT"), false);
  assert.equal(isRotateDirection(" left"), false);
  assert.equal(isRotateDirection(undefined), false);
});

test("normalizeRotateDirection returns the direction or an empty string", () => {
  assert.equal(normalizeRotateDirection("left"), "left");
  assert.equal(normalizeRotateDirection("right"), "right");
  assert.equal(normalizeRotateDirection("diagonal"), "");
  assert.equal(normalizeRotateDirection(null), "");
});

test("canRotateImage allows a named, static image in edit mode", () => {
  const image = { name: "LA0001-01.jpg", animated: false };
  assert.equal(canRotateImage(image, EDIT), true);
  assert.equal(canRotate(image, EDIT), true);
  assert.equal(canRotateImage(image), false);
});

test("canRotateImage is disabled while the images tab is busy", () => {
  const image = { name: "LA0001-01.jpg" };
  for (const busy of [true, "optimize", 1]) {
    assert.equal(canRotateImage(image, { mode: "edit", busy }), false);
  }
});

test("canRotateImage is disabled outside edit mode", () => {
  const image = { name: "LA0001-01.jpg" };
  assert.equal(canRotateImage(image, { mode: "create" }), false);
  assert.equal(canRotateImage(image, { mode: "view" }), false);
  assert.equal(canRotateImage(image, { busy: false }), false);
});

test("canRotateImage rejects animated images and missing names", () => {
  assert.equal(canRotateImage({ name: "tanz.gif", animated: true }, EDIT), false);
  assert.equal(canRotateImage({ name: "tanz.webp", animated: true }, EDIT), false);
  assert.equal(canRotateImage({ name: "" }, EDIT), false);
  assert.equal(canRotateImage({ animated: false }, EDIT), false);
  assert.equal(canRotateImage({ name: 42 }, EDIT), false);
  assert.equal(canRotateImage(null, EDIT), false);
  assert.equal(canRotateImage(undefined, EDIT), false);
  assert.equal(canRotateImage("LA0001-01.jpg", EDIT), false);
});

test("rotateButtonLabel uses the arrow and 90 degree hint", () => {
  assert.equal(rotateButtonLabel("left"), "↺ 90°");
  assert.equal(rotateButtonLabel("right"), "↻ 90°");
  assert.equal(rotateButtonLabel("up"), "");
  assert.equal(rotateButtonLabel(undefined), "");
});

test("rotateAriaLabel names the image position and direction", () => {
  assert.equal(rotateAriaLabel(1, "left"), "Bild 1 um 90° gegen den Uhrzeigersinn drehen");
  assert.equal(rotateAriaLabel(3, "right"), "Bild 3 um 90° im Uhrzeigersinn drehen");
  assert.equal(rotateAriaLabel("4", "right"), "Bild 4 um 90° im Uhrzeigersinn drehen");
  assert.equal(rotateAriaLabel(2.9, "left"), "Bild 2 um 90° gegen den Uhrzeigersinn drehen");
});

test("rotateAriaLabel rejects invalid positions and directions", () => {
  assert.equal(rotateAriaLabel(0, "left"), "");
  assert.equal(rotateAriaLabel(-1, "left"), "");
  assert.equal(rotateAriaLabel(Number.NaN, "left"), "");
  assert.equal(rotateAriaLabel("x", "left"), "");
  assert.equal(rotateAriaLabel(undefined, "left"), "");
  assert.equal(rotateAriaLabel(1, "up"), "");
});

test("rotateNoticeText reports the success message in German", () => {
  assert.equal(rotateNoticeText("left"), "Bild wurde um 90° nach links gedreht.");
  assert.equal(rotateNoticeText("right"), "Bild wurde um 90° nach rechts gedreht.");
  assert.equal(rotateNoticeText("up"), "");
  assert.equal(rotateNoticeText(null), "");
});

test("rotateTargetSelector builds an attribute selector", () => {
  assert.equal(
    rotateTargetSelector("LA0001-01.jpg", "left"),
    '[data-image="LA0001-01.jpg"][data-direction="left"]',
  );
  assert.equal(
    rotateTargetSelector("LA0001-02.png", "right"),
    '[data-image="LA0001-02.png"][data-direction="right"]',
  );
});

test("rotateTargetSelector escapes quotes and backslashes", () => {
  assert.equal(
    rotateTargetSelector('a"b.jpg', "left"),
    '[data-image="a\\"b.jpg"][data-direction="left"]',
  );
  assert.equal(
    rotateTargetSelector("a\\b.jpg", "right"),
    '[data-image="a\\\\b.jpg"][data-direction="right"]',
  );
});

test("rotateTargetSelector is empty without a usable name or direction", () => {
  assert.equal(rotateTargetSelector("", "left"), "");
  assert.equal(rotateTargetSelector(undefined, "left"), "");
  assert.equal(rotateTargetSelector("LA0001-01.jpg", "up"), "");
  assert.equal(rotateTargetSelector("LA0001-01.jpg", undefined), "");
});
