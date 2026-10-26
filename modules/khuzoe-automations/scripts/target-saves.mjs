/** Prefer the target's assigned, connected player, then another connected owner.
 * Use effective permissions so synthetic actors and default ownership work too.
 */
function saveOwner(actor) {
  const users = Array.from(globalThis.game?.users?.values?.() ?? []);
  const players = users.filter(user => {
    if (!user.active || user.isGM) return false;
    if (actor.testUserPermission) return actor.testUserPermission(user, "OWNER");
    const permission = actor.ownership?.[user.id];
    return Number(permission == null || permission === -1 ? actor.ownership?.default : permission) >= 3;
  });
  const assigned = players.find(user => user.character?.uuid === actor.uuid
    || (user.character?.id && user.character.id === actor.id));
  if (assigned || players.length) return assigned ?? players[0];
  const gm = globalThis.cat?.utils?.queryUtils?.gmUser?.() ?? globalThis.game?.users?.activeGM;
  return (gm?.isGM && gm.active !== false ? gm : null)
    ?? users.find(user => user.active && user.isGM)
    ?? (globalThis.game?.user?.isGM ? game.user : null);
}

/** Ask on the defender's client, preserving its native D&D5e/Midi/CAT roll.
 * Never reroll locally after a remote cancellation or error: a roll may already
 * have completed on that client, and retrying would grant an extra save.
 */
export async function rollTargetSavingThrow(target, ability, dc) {
  const actor = (target?.document ?? target)?.actor;
  if (!actor) return null;
  const owner = saveOwner(actor);
  let rolls;
  try {
    if (!owner) throw new Error("Nessun proprietario o GM disponibile per il tiro salvezza.");
    if (owner.id === game.user.id) {
      rolls = await actor.rollSavingThrow(
        {ability, midiOptions: {target: dc}},
        {configure: true, target: dc},
        {create: true}
      );
    } else {
      const socket = globalThis.MidiQOL?.socket?.();
      if (!socket?.executeAsUser || !actor.uuid) throw new Error("Collegamento al proprietario del bersaglio non disponibile.");
      rolls = await socket.executeAsUser("rollAbilityV2", owner.id, {
        saveDetails: {
          actorUuid: actor.uuid, rollType: "save", rollAbilities: [ability],
          rollSkills: [], rollTools: [], rollDC: dc, isMagicSave: false,
          isFriendly: false, saveItemUuid: "", workflowOptions: {},
          workflowId: "", itemCardUuid: "", itemId: ""
        },
        displayOptions: {fastForward: false, chatMessage: true, showTargetDC: true}
      });
    }
  } catch (error) {
    console.error("Khuzoe Automations | Richiesta del TS del bersaglio non riuscita.", error);
    globalThis.ui?.notifications?.warn?.(`${actor.name ?? "Bersaglio"}: richiesta del tiro salvezza non completata.`);
    return null;
  }
  const roll = Array.isArray(rolls) ? rolls[0] : rolls;
  // Socketlib serializes Roll instances; only the evaluated total is needed.
  const value = roll?.total ?? roll?._total;
  if (value == null || value === "" || !Number.isFinite(Number(value))) return null;
  const total = Number(value);
  return {roll, total, success: total >= dc, margin: dc - total};
}
