import {writeFile} from "node:fs/promises";
import {specialActivity, specialDamage} from "../scripts/special-spell-catalog.mjs";

const MODULE = "khuzoe-automations";
const cast = specialActivity("crownOfStars", {name: "Crea la corona", activation: "action", spellSlot: true,
  targetType: "self", range: "self", duration: "hour", durationValue: "1"});
cast.target.prompt = false;
const mote = specialActivity("crownOfStarsMote", {name: "Scaglia una stella", activation: "bonus", type: "attack",
  hidden: true, targetType: "creatureOrObject", range: "ft", distance: "120", parts: [specialDamage(4, 12, "radiant")]});
mote.midiProperties.automationOnly = false;
mote.consumption.targets = [{type: "activityUses", value: "1", target: "", scaling: {}}];
mote.uses.max = "0";
const item = {
  _id: "KhzCrownStars001", name: "Crown of Stars", type: "spell",
  img: "icons/magic/light/explosion-star-large-blue-yellow.webp",
  system: {
    identifier: "crown-of-stars",
    description: {value: "<p>Crei sette stelle che orbitano intorno alla testa per 1 ora, senza concentrazione. Con uno slot di 8° livello ne crei nove; con uno di 9° ne crei undici.</p><p>Come azione bonus, scagli una stella contro una creatura o un oggetto entro 120 ft (36,576 m). Effettua un attacco con incantesimo a distanza: se colpisci, infliggi 4d12 danni radianti. La stella viene consumata anche se manchi.</p><p>Con almeno quattro stelle: luce intensa entro 30 ft e fioca fino a 60 ft. Con una, due o tre: solo luce fioca entro 30 ft. L'incantesimo termina quando consumi l'ultima stella o scade la durata.</p><p><strong>Automazione:</strong> usa «Crea la corona», poi «Scaglia una stella». Gli utilizzi dell'attività indicano le stelle rimaste e non si recuperano con i riposi. Un nuovo lancio sostituisce la corona precedente. Mantieni attivo il consumo degli utilizzi quando scagli una stella.</p>", chat: ""},
    source: {custom: "Xanathar's Guide to Everything", rules: "2014", revision: 1},
    ability: "", level: 7, school: "evo", method: "spell", prepared: 0, sourceItem: "",
    activation: {type: "action", value: 1, condition: ""}, duration: {value: "1", units: "hour"},
    range: {units: "self", special: ""}, target: structuredClone(cast.target),
    uses: {max: "", spent: 0, recovery: []}, properties: ["vocal", "somatic", "mgc"],
    materials: {value: "", consumed: false, cost: 0, supply: 0},
    activities: {[cast._id]: cast, [mote._id]: mote}
  },
  effects: [],
  flags: {
    cat: {automation: {source: MODULE, version: "0.28.0"}, macros: {roll: [{source: MODULE, rules: "2014", identifier: "crown-of-stars"}]}},
    [MODULE]: {sourceIdentifier: "crown-of-stars", activityIdentifiers: {crownOfStars: cast._id, crownOfStarsMote: mote._id}},
    dnd5e: {riders: {activity: [], effect: []}}
  },
  folder: null, sort: 0, ownership: {default: 0}, _key: "!items!KhzCrownStars001"
};
delete item.system.target.override;
delete item.system.target.prompt;
await writeFile(new URL("../packData/khuzoe-spells-2014/Crown_of_Stars_KhzCrownStars001.json", import.meta.url), `${JSON.stringify(item, null, 2)}\n`);
console.log("Crown of Stars: sorgente compendio generata.");
