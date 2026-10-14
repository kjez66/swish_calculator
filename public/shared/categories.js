/**
 * The categories a product can belong to. Shared by the server, which accepts
 * only these ids, and the till, which tints a product's tile by its category.
 * Ids are stored and never shown; names are shown.
 * @module
 */

export const CATEGORIES = [
  { id: "dryck", name: "Dryck" },
  { id: "mat", name: "Mat" },
  { id: "fika", name: "Fika" },
  { id: "godis", name: "Godis" },
  { id: "ovrigt", name: "Övrigt" },
];

/**
 * The name shown for a category id; undefined for no category.
 * @param {string | undefined} id
 */
export const categoryName = (id) => CATEGORIES.find((c) => c.id === id)?.name;

/** @param {unknown} id */
export const isCategory = (id) => CATEGORIES.some((c) => c.id === id);
