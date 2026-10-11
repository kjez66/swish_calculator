/**
 * The order counter must roll over at Stockholm midnight. UTC rolls over at 01:00
 * or 02:00 local, which would reset order numbers mid-evening during a late market.
 * sv-SE formats as YYYY-MM-DD.
 * @param {Date} date
 * @returns {string}
 */
export function stockholmDate(date) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
