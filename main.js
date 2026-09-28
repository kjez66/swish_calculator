/**
 * Entry point. Deno Deploy runs this file.
 */
import { createStore } from "./src/store.js";
import { createHub } from "./src/hub.js";
import { createHandler } from "./src/server.js";

const kv = await Deno.openKv();
const store = createStore(kv);
const hub = createHub(store);
Deno.serve(createHandler({ store, hub }));
