/*
 * Script Slots (FVTT v13)
 * - GM config UI stored in world settings
 * - Players request run via module socket; only GM executes
 * - No external template files (avoids ENOENT issues)
 */

const MODULE_ID = "script-slots";
const SOCKET = `module.${MODULE_ID}`;

const SETTINGS = {
  SLOTS: "slots",
  REQUIRE_OWNER: "requireActorOwner",
  REQUIRE_TOKEN: "requireTokenOnScene"
};

function notifyGMOnly() {
  ui.notifications.warn("Script Slots: only a GM can do that.");
}

function isString(v) {
  return typeof v === "string" || v instanceof String;
}

function normalizeSlotName(name) {
  return (name ?? "").toString().trim();
}

async function getSlots() {
  return (game.settings.get(MODULE_ID, SETTINGS.SLOTS) ?? []);
}

async function setSlots(slots) {
  await game.settings.set(MODULE_ID, SETTINGS.SLOTS, slots);
}

function findSlot(slots, name) {
  const n = normalizeSlotName(name);
  return slots.find(s => normalizeSlotName(s.name) === n);
}

function compileRunner(code) {
  // Supports either:
  //  A) Full "async function run(ctx) { ... }" definition
  //  B) Just the body of the function
  const src = (code ?? "").toString();
  const hasRunDecl = /\basync\s+function\s+run\s*\(/.test(src) || /\bfunction\s+run\s*\(/.test(src);

  if (hasRunDecl) {
    // Wrap in IIFE returning run
    const factory = new Function(`"use strict"; ${src}; return run;`);
    const fn = factory();
    if (typeof fn !== "function") throw new Error("Script does not define a run(ctx) function.");
    return fn;
  }

  // Treat as body
  const fn = new Function("ctx", `"use strict"; return (async () => {\n${src}\n})();`);
  return fn;
}

function buildCtx({ slotName, args, requestedByUserId }) {
  const requestedBy = game.users.get(requestedByUserId) ?? null;

  // Try to resolve actor/token from args
  let actor = null;
  let token = null;

  const actorId = args?.actorId;
  if (actorId) actor = game.actors.get(actorId) ?? null;

  // If tokenId provided, prefer that
  const tokenId = args?.tokenId;
  if (tokenId && canvas?.tokens) token = canvas.tokens.get(tokenId) ?? null;

  // If we have an actor but no token, try to find a token on current scene
  if (!token && actor && canvas?.tokens) {
    token = canvas.tokens.placeables.find(t => t.actor?.id === actor.id) ?? null;
  }

  return {
    module: MODULE_ID,
    slotName,
    args: args ?? {},
    requestedBy,
    user: requestedBy,
    actor,
    token,
    scene: canvas?.scene ?? game.scenes.current,
    game,
    ui,
    canvas
  };
}

async function validateRequest({ args, requestedByUserId }) {
  const requireOwner = game.settings.get(MODULE_ID, SETTINGS.REQUIRE_OWNER);
  const requireToken = game.settings.get(MODULE_ID, SETTINGS.REQUIRE_TOKEN);

  if (!requireOwner && !requireToken) return;

  const actorId = args?.actorId;
  if (!actorId) {
    throw new Error("Missing args.actorId for this world (Require Actor Owner / Require Token on Scene is enabled). ");
  }

  const actor = game.actors.get(actorId);
  if (!actor) throw new Error(`Actor not found for actorId: ${actorId}`);

  const user = game.users.get(requestedByUserId);
  if (!user) throw new Error(`Requesting user not found: ${requestedByUserId}`);

  if (requireOwner) {
    const isOwner = actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
    if (!isOwner) throw new Error(`${user.name} is not OWNER of ${actor.name}.`);
  }

  if (requireToken) {
    const hasToken = canvas?.tokens?.placeables?.some(t => t.actor?.id === actorId);
    if (!hasToken) throw new Error(`No token for ${actor.name} on the current scene.`);
  }
}

class ScriptSlotsConfig extends Application {
  static get defaultOptions() {
    return mergeObject(super.defaultOptions, {
      id: "script-slots-config",
      title: "Script Slots",
      width: 820,
      height: 520,
      resizable: true,
      classes: ["script-slots"],
      tabs: [{ navSelector: ".tabs", contentSelector: ".content", initial: "slots" }]
    });
  }

  async getData() {
    const slots = await getSlots();
    return {
      isGM: game.user.isGM,
      slots: slots.map(s => ({
        name: s.name ?? "",
        enabled: !!s.enabled,
        code: s.code ?? ""
      })),
      requireOwner: !!game.settings.get(MODULE_ID, SETTINGS.REQUIRE_OWNER),
      requireToken: !!game.settings.get(MODULE_ID, SETTINGS.REQUIRE_TOKEN)
    };
  }

  async _renderInner(data) {
    const slotOptions = data.slots
      .map(s => `<option value="${Handlebars.escapeExpression(s.name)}">${Handlebars.escapeExpression(s.name)}</option>`)
      .join("");

    return `
<div class="slots-header">
  <div style="display:flex;gap:8px;align-items:center;">
    <button type="button" class="ss-add"><i class="fas fa-plus"></i> Add</button>
    <button type="button" class="ss-delete"><i class="fas fa-trash"></i> Delete</button>
    <button type="button" class="ss-export"><i class="fas fa-file-export"></i> Export</button>
    <button type="button" class="ss-import"><i class="fas fa-file-import"></i> Import</button>
  </div>
  <div class="muted">Author scripts as <code>async function run(ctx) { ... }</code> or just the body.</div>
</div>

<div style="display:flex;gap:10px;height:430px;">
  <div style="flex:0 0 280px;display:flex;flex-direction:column;gap:8px;">
    <label>Slot</label>
    <select class="ss-select">${slotOptions}</select>

    <label>Name</label>
    <input type="text" class="ss-name" placeholder="e.g. Ouroboros: Sin" />

    <label style="display:flex;align-items:center;gap:8px;">
      <input type="checkbox" class="ss-enabled" /> Enabled
    </label>

    <hr />

    <label style="display:flex;align-items:center;gap:8px;">
      <input type="checkbox" class="ss-require-owner" ${data.requireOwner ? "checked" : ""} /> Require Actor Owner
    </label>
    <label style="display:flex;align-items:center;gap:8px;">
      <input type="checkbox" class="ss-require-token" ${data.requireToken ? "checked" : ""} /> Require Token on Scene
    </label>
    <div class="muted">These checks apply to player-triggered runs.</div>

    <hr />
    <button type="button" class="ss-save"><i class="fas fa-save"></i> Save</button>
    <button type="button" class="ss-run"><i class="fas fa-play"></i> Run (as GM)</button>
  </div>

  <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
    <label>Code</label>
    <textarea class="ss-code" spellcheck="false" placeholder="// Example:\n// const {actor, token, args} = ctx;\n// ui.notifications.info('Hello '+actor?.name);\n"></textarea>
    <div class="muted">
      Tip: from a macro you can run this slot with
      <code>game.scriptsSlots.run('Slot Name', { actorId: actor.id })</code>
    </div>
  </div>
</div>
`;
  }

  activateListeners(html) {
    super.activateListeners(html);

    const $select = html.find(".ss-select");
    const $name = html.find(".ss-name");
    const $enabled = html.find(".ss-enabled");
    const $code = html.find(".ss-code");

    const loadSelected = async () => {
      const slots = await getSlots();
      const chosen = $select.val();
      const slot = findSlot(slots, chosen) ?? slots[0] ?? null;
      if (!slot) {
        $name.val("");
        $enabled.prop("checked", false);
        $code.val("");
        return;
      }
      $select.val(slot.name);
      $name.val(slot.name);
      $enabled.prop("checked", !!slot.enabled);
      $code.val(slot.code ?? "");
    };

    const refreshSelect = async (keepName = null) => {
      const slots = await getSlots();
      $select.empty();
      for (const s of slots) {
        $select.append(`<option value="${Handlebars.escapeExpression(s.name)}">${Handlebars.escapeExpression(s.name)}</option>`);
      }
      if (keepName) $select.val(keepName);
      await loadSelected();
    };

    // Initial load
    loadSelected();

    $select.on("change", loadSelected);

    html.find(".ss-add").on("click", async () => {
      if (!game.user.isGM) return notifyGMOnly();
      const name = (await Dialog.prompt({
        title: "Add Script Slot",
        content: `<p>Slot name:</p><input type="text" style="width:100%" />`,
        label: "Add",
        callback: (html2) => html2.find("input").val()
      }))?.trim();
      if (!name) return;

      const slots = await getSlots();
      if (findSlot(slots, name)) return ui.notifications.error("That slot name already exists.");

      slots.push({ name, enabled: true, code: "" });
      await setSlots(slots);
      await refreshSelect(name);
    });

    html.find(".ss-delete").on("click", async () => {
      if (!game.user.isGM) return notifyGMOnly();
      const chosen = $select.val();
      if (!chosen) return;
      const ok = await Dialog.confirm({
        title: "Delete Script Slot",
        content: `<p>Delete <strong>${Handlebars.escapeExpression(chosen)}</strong>?</p>`
      });
      if (!ok) return;

      const slots = await getSlots();
      const next = slots.filter(s => normalizeSlotName(s.name) !== normalizeSlotName(chosen));
      await setSlots(next);
      await refreshSelect(next[0]?.name ?? null);
    });

    html.find(".ss-export").on("click", async () => {
      if (!game.user.isGM) return notifyGMOnly();
      const slots = await getSlots();
      const json = JSON.stringify(slots, null, 2);
      await Dialog.prompt({
        title: "Export Script Slots",
        content: `<p>Copy this JSON:</p><textarea style="width:100%;height:260px;">${Handlebars.escapeExpression(json)}</textarea>`,
        label: "Close",
        callback: () => null
      });
    });

    html.find(".ss-import").on("click", async () => {
      if (!game.user.isGM) return notifyGMOnly();
      const text = await Dialog.prompt({
        title: "Import Script Slots",
        content: `<p>Paste JSON exported from Script Slots:</p><textarea style="width:100%;height:260px;"></textarea>`,
        label: "Import",
        callback: (html2) => html2.find("textarea").val()
      });
      if (!text) return;
      try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error("JSON must be an array.");
        const cleaned = parsed
          .filter(s => s && isString(s.name))
          .map(s => ({
            name: normalizeSlotName(s.name),
            enabled: !!s.enabled,
            code: (s.code ?? "").toString()
          }))
          .filter(s => !!s.name);
        await setSlots(cleaned);
        await refreshSelect(cleaned[0]?.name ?? null);
        ui.notifications.info("Script Slots imported.");
      } catch (e) {
        console.error(e);
        ui.notifications.error(`Import failed: ${e.message}`);
      }
    });

    html.find(".ss-save").on("click", async () => {
      if (!game.user.isGM) return notifyGMOnly();
      const chosen = $select.val();
      const newName = normalizeSlotName($name.val());
      if (!newName) return ui.notifications.error("Name is required.");

      const slots = await getSlots();
      const slot = findSlot(slots, chosen);
      if (!slot) return ui.notifications.error("No slot selected.");

      // If renaming, ensure unique
      if (normalizeSlotName(chosen) !== newName && findSlot(slots, newName)) {
        return ui.notifications.error("Another slot already has that name.");
      }

      slot.name = newName;
      slot.enabled = !!$enabled.prop("checked");
      slot.code = ($code.val() ?? "").toString();

      await setSlots(slots);
      await refreshSelect(newName);
      ui.notifications.info("Script slot saved.");
    });

    html.find(".ss-run").on("click", async () => {
      if (!game.user.isGM) return notifyGMOnly();
      const chosen = $select.val();
      if (!chosen) return ui.notifications.error("No slot selected.");

      // Build ctx without requester
      const ctx = buildCtx({ slotName: chosen, args: {}, requestedByUserId: game.user.id });
      try {
        const slots = await getSlots();
        const slot = findSlot(slots, chosen);
        if (!slot) throw new Error("Slot not found.");
        const fn = compileRunner(slot.code);
        await fn(ctx);
        ui.notifications.info(`Ran: ${chosen}`);
      } catch (e) {
        console.error(e);
        ui.notifications.error(`Run failed: ${e.message}`);
      }
    });

    html.find(".ss-require-owner").on("change", async (ev) => {
      if (!game.user.isGM) return notifyGMOnly();
      await game.settings.set(MODULE_ID, SETTINGS.REQUIRE_OWNER, !!ev.currentTarget.checked);
    });

    html.find(".ss-require-token").on("change", async (ev) => {
      if (!game.user.isGM) return notifyGMOnly();
      await game.settings.set(MODULE_ID, SETTINGS.REQUIRE_TOKEN, !!ev.currentTarget.checked);
    });
  }
}

async function runSlotAsGM({ name, args = {}, requestedByUserId }) {
  const slots = await getSlots();
  const slot = findSlot(slots, name);
  if (!slot) throw new Error(`Script slot not found: ${name}`);
  if (!slot.enabled) throw new Error(`Script slot disabled: ${name}`);

  await validateRequest({ args, requestedByUserId });

  const ctx = buildCtx({ slotName: name, args, requestedByUserId });
  const fn = compileRunner(slot.code);
  return await fn(ctx);
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTINGS.SLOTS, {
    name: "Script Slots",
    scope: "world",
    config: false,
    type: Array,
    default: []
  });

  game.settings.register(MODULE_ID, SETTINGS.REQUIRE_OWNER, {
    name: "Require Actor Owner",
    hint: "If enabled, the requesting player must have OWNER permission on the actor they request.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.REQUIRE_TOKEN, {
    name: "Require Token on Scene",
    hint: "If enabled, execution requires a token for the actor on the current scene.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
});

Hooks.once("ready", () => {
  // Public API
  game.scriptsSlots = {
    openConfig: () => {
      if (!game.user.isGM) return notifyGMOnly();
      new ScriptSlotsConfig().render(true);
    },
    list: async () => (await getSlots()).map(s => s.name),
    run: async (name, args = {}) => {
      const slotName = normalizeSlotName(name);
      if (!slotName) throw new Error("Missing slot name");

      // GM can run directly
      if (game.user.isGM) {
        return await runSlotAsGM({ name: slotName, args, requestedByUserId: game.user.id });
      }

      // Players request via socket
      return await new Promise((resolve, reject) => {
        game.socket.emit(SOCKET, {
          op: "run",
          name: slotName,
          args: args ?? {},
          requestedByUserId: game.user.id
        });

        // We don't get a true return channel without a more complex protocol;
        // so resolve immediately and let the GM-side script post to chat / apply effects.
        resolve(true);
      });
    }
  };

  // Socket listener (GM executes)
  game.socket.on(SOCKET, async (payload) => {
    try {
      if (!payload || payload.op !== "run") return;
      if (!game.user.isGM) return; // only GM executes

      const { name, args, requestedByUserId } = payload;
      await runSlotAsGM({ name, args, requestedByUserId });
    } catch (e) {
      console.error(e);
      ui.notifications.error(`Script Slots error: ${e.message}`);
    }
  });

  // Convenience: add a button in module settings area via a global macro call
  if (game.user.isGM) {
    console.log("[script-slots] ready. Use game.scriptsSlots.openConfig()");
  }
});
