import {compilePack} from "@foundryvtt/foundryvtt-cli";

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Uso: compile-pack.mjs <sorgente> <destinazione>");

await compilePack(source, destination, {log: true});
