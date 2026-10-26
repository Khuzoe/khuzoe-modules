// SmallTime's 24-hour UI reads raw world seconds. Adapt that read to the native
// calendar epoch, without editing SmallTime or claiming support for its custom-day UI.
export function adaptSmallTime(Helpers) {
  const original = Helpers?.getWorldTimeSecondsOfDay;
  if (typeof original !== "function" || original.khuzoeCalendar) return;
  function secondsOfDay(...args) {
    const calendar = globalThis.game?.time?.calendar;
    const days = calendar?.days;
    if (calendar?.constructor?.khuzoeCalendar && days?.hoursPerDay === 24 && days?.minutesPerHour === 60 && days?.secondsPerMinute === 60) {
      const time = calendar.timeToComponents(game.time.worldTime);
      return Math.trunc(time.hour * 3600 + time.minute * 60 + time.second);
    }
    return original.apply(this, args);
  }
  secondsOfDay.khuzoeCalendar = true;
  Helpers.getWorldTimeSecondsOfDay = secondsOfDay;
}

export async function installSmallTimeAdapter() {
  if (!game.modules.get("smalltime")?.active) return;
  const { Helpers } = await import("../../smalltime/scripts/helpers.mjs");
  if (typeof Helpers?.getWorldTimeSecondsOfDay !== "function") throw new Error("Questa versione di SmallTime non espone il lettore dell'ora compatibile.");
  adaptSmallTime(Helpers);
}
