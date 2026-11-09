import {mkdir, writeFile} from "node:fs/promises";
import {GINEVRA_AUTOMATION} from "../scripts/ginevra.mjs";
import {normalizeAutomationData} from "../scripts/pack-normalization.mjs";

const id = "KhzGinevraEmbr01";
const img = "modules/khuzoe-automations/assets/ginevra-embrace.webp";
const macro = {source: "khuzoe-automations", rules: "2024", identifier: GINEVRA_AUTOMATION.identifier};
const target = type => ({override: true, prompt: type !== "self", affects: {count: type === "self" ? "" : "1", type}, template: {units: "ft"}});
const utility = (activityId, name, activation, kind, consume = false) => ({
  _id: activityId, type: "utility", name,
  activation: {type: activation, value: 1, override: true},
  consumption: {targets: consume ? [{type: "itemUses", target: "", value: "1", scaling: {mode: "", formula: ""}}] : [],
    spellSlot: false, scaling: {allowed: false}},
  duration: {units: "inst", concentration: false, override: true},
  effects: [], range: {value: kind === "self" ? null : "60", units: kind === "self" ? "self" : "ft", override: true},
  target: target(kind), roll: {formula: "", prompt: false, visible: false},
  midiProperties: {confirmTargets: kind === "self" ? "never" : "default"},
  uses: {max: "", spent: 0, recovery: []}
});

const item = {
  _id: id, _key: `!items!${id}`, name: "Abbraccio di Ginevra", type: "feat", img,
  system: {
    identifier: GINEVRA_AUTOMATION.identifier,
    source: {rules: "2024", custom: "Cripta di Sangue"},
    type: {value: "class"},
    description: {value: `<p><em>I tuoi occhi diventano gialli e il tuo corpo si copre parzialmente di piume dorate.</em></p>
      <h3>Effetto base</h3><ul><li>Ottieni scurovisione entro 60 piedi.</li><li>Ottieni resistenza ai danni radiosi.</li>
      </ul>
      <p><strong>Attivazione.</strong> Come azione bonus, puoi manifestare lo Spirito di Ginevra alle tue spalle per 1 minuto.
      Puoi usare questa capacità un numero di volte pari al tuo modificatore di Saggezza e recuperi tutti gli utilizzi spesi al termine di un riposo lungo.</p>
      <blockquote><p><strong>Durante Abbraccio di Ginevra</strong></p><ul><li>Ottieni resistenza a tutti i danni.</li>
      <li>I tuoi attacchi in mischia infliggono 2d4 danni radiosi aggiuntivi.</li>
      <li>Ogni volta che infliggi danni a un nemico, Ginevra accumula cariche pari ai danni effettivamente inflitti, fino a 100.</li></ul>
      <p><strong>Spendere le cariche.</strong> Come azione, consumi tutte le cariche accumulate e scegli uno degli effetti seguenti:</p>
      <ul><li><strong>Angelo della Vita.</strong> Una creatura a tua scelta entro 60 piedi recupera punti ferita pari alle cariche consumate.</li>
      <li><strong>Angelo della Morte.</strong> Una creatura a tua scelta entro 60 piedi effettua un tiro salvezza su Destrezza contro la CD dei tuoi incantesimi. Se lo fallisce, subisce danni radiosi pari alle cariche consumate; se lo supera, subisce la metà di quei danni.</li></ul></blockquote>
      <p><strong>Origine:</strong> Albero abilità - Circolo della Nascita.</p>`, chat: ""},
    activities: {
      KhzGinActivate01: utility("KhzGinActivate01", "Manifesta lo Spirito di Ginevra", "bonus", "self", true),
      KhzGinLife000001: utility("KhzGinLife000001", "Angelo della Vita", "action", "creature"),
      KhzGinDeath00001: utility("KhzGinDeath00001", "Angelo della Morte", "action", "creature")
    },
    uses: {max: "max(0, @abilities.wis.mod)", spent: 0, recovery: [{period: "lr", type: "recoverAll"}]},
    properties: [], requirements: ""
  },
  effects: [{
    _id: "KhzGinevraBase01", _key: `!items.effects!${id}.KhzGinevraBase01`,
    name: "Abbraccio di Ginevra: effetto base", img, type: "base", origin: null,
    transfer: true, disabled: false, duration: {value: null, units: "seconds", expired: false},
    showIcon: 0, statuses: [], system: {changes: [
      {key: "system.attributes.senses.ranges.darkvision", type: "upgrade", value: "60", priority: 20},
      {key: "system.traits.dr.value", type: "add", value: "radiant", priority: 20}
    ]}, flags: {dae: {transfer: true, stackable: "noneNameOnly", specialDuration: [], expiryMode: "delete"}}
  }],
  folder: null, sort: 0, ownership: {default: 0},
  flags: {cat: {automation: {source: "khuzoe-automations", version: GINEVRA_AUTOMATION.version},
    macros: {roll: [macro]}}, "midi-qol": {forceCEOff: true}}
};

const directory = new URL("../packData/khuzoe-class-features-2014/", import.meta.url);
await mkdir(directory, {recursive: true});
await writeFile(new URL(`Abbraccio_di_Ginevra_${id}.json`, directory), JSON.stringify(normalizeAutomationData(item), null, 2) + "\n");
console.log("Generato Abbraccio di Ginevra senza accesso ai mondi.");
