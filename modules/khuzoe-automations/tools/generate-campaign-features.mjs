import {mkdir, writeFile} from "node:fs/promises";
import {CAMPAIGN_AUTOMATIONS} from "../scripts/campaign-features.mjs";
import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";

// Campaign rules transcribed from the audited Items; no world database is read or changed.
const content = {
  defense: ["icons/skills/melee/shield-block-gray-yellow.webp", "<p><em>Rinunci alla precisione dei tuoi colpi per concentrare ogni movimento sulla difesa e sulla reazione agli attacchi avversari.</em></p><p>All'inizio del tuo turno, prima di effettuare il tuo primo attacco, puoi scegliere di attivare <strong>Difesa Impenetrabile</strong>. Fino all'inizio del tuo prossimo turno, tutti i tuoi attacchi vengono effettuati con <strong>svantaggio</strong>, indipendentemente da qualsiasi bonus o effetto che normalmente concederebbe vantaggio o annullerebbe lo svantaggio.</p><p>Durante questo periodo, tutti i tiri per colpire effettuati contro di te vengono effettuati con <strong>svantaggio</strong>.</p>"],
  premonition: ["icons/magic/perception/eye-ringed-glow-angry-small-red.webp", "<p>Quando una creatura ostile ti colpisce con un attacco, ottieni +1 alla Classe Armatura fino all'inizio del tuo turno successivo. Il bonus si accumula fino al tuo modificatore di Saggezza.</p>"],
  reasoning: ["icons/magic/perception/eye-tendrils-web-purple.webp", "<p>Quando effettui una prova di caratteristica, un tiro salvezza o un tiro per colpire, puoi scegliere di applicare Ragionamento Preciso prima di conoscere l'esito. Tira 1d6 e aggiungi il risultato al tiro.</p><p>Usi pari al modificatore di Intelligenza (minimo 1), recuperati al riposo lungo. Ogni 20 naturale su un tiro salvezza o un tiro per colpire recupera un uso.</p>"],
  lucky: ["icons/magic/perception/eye-tendrils-web-purple.webp", "<p>Quando usi Ragionamento Preciso per migliorare un tiro salvezza, puoi scegliere di ottenere anche vantaggio su quel tiro.</p><p>Se possiedi Eludere (Evasion), si applica anche agli effetti che consentono un tiro salvezza su Intelligenza per dimezzare i danni.</p>"],
  regeneration: ["icons/magic/life/heart-cross-strong-purple-orange.webp", "<p>The shield guardian regains 10 hit points at the start of its turn if it has at least 1 hit point.</p>"]
};

function utility(id, name) {
  return {_id: id, type: "utility", name,
    activation: {type: "special", value: null, override: true},
    consumption: {targets: [], scaling: {allowed: false}, spellSlot: false},
    duration: {units: "inst", concentration: false, override: true}, effects: [],
    target: {override: true, prompt: false, affects: {type: "self"}, template: {units: "ft"}},
    range: {units: "self", override: true}, roll: {formula: "", prompt: false, visible: false},
    midiProperties: {confirmTargets: "never"}, uses: {max: "", spent: 0, recovery: []}
  };
}
for (const data of CAMPAIGN_AUTOMATIONS) {
  const id = data.uuid.split(".").at(-1), [img, description] = content[data.key];
  const activities = {};
  if (data.key === "defense") activities.KhzGuardActivate = utility("KhzGuardActivate", "Attiva Difesa Impenetrabile");
  const groups = data.key === "defense" ? ["roll", "combat"]
    : data.key === "reasoning" ? ["roll", "save", "check", "skill", "tool"]
    : data.key === "regeneration" ? ["combat"] : data.key === "lucky" ? [] : ["roll"];
  const item = {_id: id, _key: `!items!${id}`, name: data.name, type: "feat", img,
    system: {identifier: data.identifier, source: {rules: data.rules, custom: data.key === "regeneration" ? "Shield Guardian 2014" : "Cripta di Sangue"},
      description: {value: description, chat: ""}, type: {value: data.key === "regeneration" ? "monster" : "class"},
      activities, uses: data.key === "reasoning" ? {max: "max(1, @abilities.int.mod)", spent: 0, recovery: [{period: "lr", type: "recoverAll"}]} : {max: "", spent: 0, recovery: []},
      properties: [], requirements: ""},
    effects: [], folder: null, sort: 0, ownership: {default: 0},
    flags: {cat: {automation: {source: data.source, version: data.version}, macros: Object.fromEntries(groups.map(group => [group, [{source: data.source, rules: data.rules, identifier: data.identifier}]]))},
      "khuzoe-automations": {campaignFeature: data.key}, "midi-qol": {forceCEOff: true}}
  };
  const pack = data.uuid.includes(".KhuzoeNpc") ? "khuzoe-npc-features-2014" : "khuzoe-class-features-2014";
  const directory = new URL(`../packData/${pack}/`, import.meta.url);
  await mkdir(directory, {recursive: true});
  await writeFile(new URL(`${data.name.replace(/\W+/g, "_")}_${id}.json`, directory), JSON.stringify(normalizeAutomationData(item), null, 2) + "\n");
}
console.log(`Generate ${CAMPAIGN_AUTOMATIONS.length} capacità della campagna, senza accesso ai mondi.`);
