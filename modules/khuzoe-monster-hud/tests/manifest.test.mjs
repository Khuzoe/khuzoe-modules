import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("manifest targets only the portable v14 and D&D5e 5.3 line", () => {
  const manifest = JSON.parse(readFileSync(new URL("module.json", root), "utf8"));
  assert.equal(manifest.version, "0.1.2");
  assert.equal(manifest.compatibility.minimum, "14");
  assert.equal(manifest.compatibility.verified, "14.367");
  assert.equal(manifest.relationships.systems[0].compatibility.minimum, "5.3.0");
});

test("source uses ApplicationV2 and native D&D activity hooks", () => {
  const config = readFileSync(new URL("scripts/config-app.js", root), "utf8");
  const hud = readFileSync(new URL("scripts/hud.js", root), "utf8");
  const styles = readFileSync(new URL("styles/monster-hud.css", root), "utf8");
  const main = readFileSync(new URL("scripts/main.js", root), "utf8");
  assert.match(config, /HandlebarsApplicationV2/);
  assert.doesNotMatch(config, /FormApplication/);
  assert.match(main, /dnd5e\.postUseActivity/);
  assert.match(hud, /ability\.toUpperCase\(\)/);
  assert.match(hud, /TOKEN_DISPLAY_MODES/);
  assert.match(hud, /pointermove/);
  assert.doesNotMatch(hud, /group\?\.exhausted \|\| !group\?\.active/);
  assert.doesNotMatch(hud, /typeLabel\(/);
  assert.match(styles, /\.khmh-action\.is-legendary/);
  assert.match(styles, /\.khmh-resource-legact/);
  assert.match(styles, /\.khmh-action-separator/);
  assert.match(styles, /\[data-anchor="manual"\]/);
});
