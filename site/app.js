"use strict";
(() => {
  const API = window.SANTA_API.replace(/\/$/, "");
  const TOKEN_KEY = "santa-token";
  const root = document.getElementById("app");
  const account = document.getElementById("account");
  let flash = null;

  const storage = {
    get() { try { return localStorage.getItem(TOKEN_KEY); } catch { return memoryToken; } },
    set(value) { memoryToken = value; try { localStorage.setItem(TOKEN_KEY, value); } catch {} },
    clear() { memoryToken = null; try { localStorage.removeItem(TOKEN_KEY); } catch {} },
  };
  let memoryToken = null;

  // All content goes in through text nodes, so names and notes can't inject markup.
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key === "on") Object.entries(value).forEach(([type, fn]) => node.addEventListener(type, fn));
      else if (key in node && key !== "list") node[key] = value;
      else node.setAttribute(key, value);
    }
    node.append(...children.flat(Infinity).filter((child) => child !== null && child !== undefined));
    return node;
  }

  async function api(method, path, body) {
    const headers = {};
    const token = storage.get();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch(API + path, { method, headers, body: body && JSON.stringify(body) });
    } catch {
      throw new Error("Couldn't reach the server. Check your connection and try again.");
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && token) {
      storage.clear();
      flash = { error: "Please log in again." };
      await render();
      throw Object.assign(new Error("signed out"), { handled: true });
    }
    if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    return data;
  }

  function field(label, name, attrs = {}) {
    const id = `f-${name}`;
    return [h("label", { htmlFor: id }, label), h("input", { id, name, required: true, ...attrs })];
  }

  function form(submitLabel, fields, onSubmit, buttonClass = "") {
    const error = h("div", { class: "error", role: "alert", hidden: true });
    const button = h("button", { type: "submit", class: buttonClass }, submitLabel);
    const element = h("form", {
      on: {
        async submit(event) {
          event.preventDefault();
          error.hidden = true;
          button.disabled = true;
          try {
            await onSubmit(Object.fromEntries(new FormData(element)));
          } catch (problem) {
            if (!problem.handled) {
              error.textContent = problem.message;
              error.hidden = false;
            }
          } finally {
            button.disabled = false;
          }
        },
      },
    }, error, fields, button);
    return element;
  }

  function act(label, handler, buttonClass = "quiet", ariaLabel = label) {
    const button = h("button", {
      type: "button",
      class: buttonClass,
      "aria-label": ariaLabel,
      on: {
        async click() {
          button.disabled = true;
          try {
            await handler();
          } catch (problem) {
            if (!problem.handled) {
              flash = { error: problem.message };
              await render();
            }
          } finally {
            button.disabled = false;
          }
        },
      },
    }, label);
    return button;
  }

  const banner = () => {
    if (!flash) return [];
    const nodes = [];
    if (flash.message) nodes.push(h("div", { class: "notice", role: "status" }, flash.message));
    if (flash.error) nodes.push(h("div", { class: "error", role: "alert" }, flash.error));
    if (flash.node) nodes.push(flash.node);
    flash = null;
    return nodes;
  };

  async function enter(path, values) {
    const { token } = await api("POST", path, values);
    storage.set(token);
    await render();
  }

  function loginView() {
    account.replaceChildren();
    root.replaceChildren(...banner(),
      h("section", { class: "card" }, h("h1", {}, "Welcome back"),
        form("Log in", [
          field("Your name", "name", { maxLength: 40, autocomplete: "username" }),
          field("Password", "password", { type: "password", autocomplete: "current-password" }),
        ], (values) => enter("/api/login", values))),
      h("p", { class: "muted" }, "First time here? ", h("button", { type: "button", class: "link", on: { click: registerView } }, "Join the family draw"), "."));
  }

  function registerView() {
    const alreadyJoined = () =>
      h("p", { class: "muted" }, "Already joined? ", h("button", { type: "button", class: "link", on: { click: loginView } }, "Log in"), ".");

    const details = (invite, households) => {
      const select = h("select", { id: "f-household", name: "household", required: true },
        h("option", { value: "", disabled: true, selected: true }, "Choose your household"),
        households.map((name) => h("option", { value: name }, name)));
      root.replaceChildren(
        h("section", { class: "card" }, h("h1", {}, "Join the draw"),
          h("p", { class: "muted" }, "You won't be matched with anyone in your own household."),
          form("Join", [
            field("Your name", "name", { maxLength: 40, autocomplete: "username" }),
            h("label", { htmlFor: "f-household" }, "Household"), select,
            field("Choose a password", "password", { type: "password", minLength: 8, autocomplete: "new-password" }),
          ], (values) => enter("/api/register", { ...values, invite }))),
        alreadyJoined());
    };

    root.replaceChildren(
      h("section", { class: "card" }, h("h1", {}, "Join the draw"),
        form("Continue", field("Family invite code", "invite", { autocomplete: "off" }), async ({ invite }) => {
          const { households } = await api("POST", "/api/households", { invite });
          details(invite, households);
        })),
      alreadyJoined());
  }

  function passwordCard(heading, intro) {
    return h("section", { class: "card" }, h("h2", {}, heading), h("p", { class: "muted" }, intro),
      form("Save password", field("New password", "password", { type: "password", minLength: 8, autocomplete: "new-password" }),
        async (values) => {
          await api("POST", "/api/password", values);
          flash = { message: "Your password is updated." };
          await render();
        }));
  }

  const phaseAction = (action, message, extra = {}) => async () => {
    await api("POST", "/api/admin/phase", { action, ...extra });
    flash = { message };
    await render();
  };

  function organiserCard(state) {
    let body;
    if (state.phase === "register") {
      body = [
        h("p", {}, "Share this site and invite code: ", h("code", {}, state.inviteCode)),
        act("Close sign-ups and start notes", phaseAction("close", "Registration is closed. Everyone can now add their notes."), ""),
      ];
    } else if (state.phase === "notes") {
      body = [
        h("p", {}, "When everyone has added their notes, draw the names. You won't see the results."),
        act("Draw names", phaseAction("draw", "The names are drawn! Everyone can log in to see who they got."), ""),
        act("Reopen sign-ups", phaseAction("reopen", "Registration is open again.")),
      ];
    } else {
      body = [
        h("p", { class: "muted" }, "Undoing replaces everyone's match the next time you draw."),
        form("Undo draw", h("label", { class: "check" },
          h("input", { type: "checkbox", name: "confirm", value: "yes", required: true }), "Yes, undo the draw"),
          phaseAction("undo", "The draw was undone.", { confirm: true }), "danger"),
      ];
    }
    return h("section", { class: "card" }, h("h2", {}, "Organiser"), body);
  }

  function personRow(person, state) {
    const status = state.phase === "register" ? "" : ` · ${person.hasNotes ? "✓ notes added" : "no notes yet"}`;
    let controls = null;
    if (state.me.isOrganiser && person.id !== state.me.id) {
      controls = h("div", { class: "actions" },
        act("Reset password", async () => {
          const { name, temporary } = await api("POST", "/api/admin/reset", { id: person.id });
          flash = { node: h("div", { class: "notice", role: "status" }, `Temporary password for ${name}: `, h("code", {}, temporary),
            h("br"), "Send it to them. They must change it when they log in.") };
          await render();
        }, "quiet", `Reset password for ${person.name}`),
        state.phase === "drawn" ? null : act("Remove", async () => {
          await api("POST", "/api/admin/remove", { id: person.id });
          flash = { message: `${person.name} was removed.` };
          await render();
        }, "quiet", `Remove ${person.name}`));
    }
    return h("li", {}, h("span", {}, h("strong", {}, person.name), h("span", { class: "muted" }, person.household + status)), controls);
  }

  function dashboard(state) {
    account.replaceChildren(act("Log out", async () => {
      await api("POST", "/api/logout").catch(() => {});
      storage.clear();
      await render();
    }));
    if (state.me.mustChange) {
      root.replaceChildren(...banner(), passwordCard("Choose a new password", "You logged in with a temporary password. Pick your own to continue."));
      return;
    }
    const labels = [["register", "1. Sign up"], ["notes", "2. Add notes"], ["drawn", "3. Names drawn"]];
    const nodes = [...banner(), h("h1", {}, `Hello, ${state.me.name}`),
      h("ol", { class: "steps" }, labels.map(([key, label]) =>
        h("li", key === state.phase ? { class: "on", "aria-current": "step" } : {}, label)))];

    if (state.phase === "register") {
      nodes.push(h("section", { class: "card" }, h("h2", {}, "Waiting for everyone to join"),
        h("p", { class: "muted" }, "Once the organiser closes sign-ups, you can add your gift notes here.")));
    }
    if (state.match) {
      nodes.push(h("details", { class: "reveal" }, h("summary", {}, "Tap to reveal who you got"),
        h("p", { class: "recipient" }, state.match.name), h("p", {}, "Keep it secret!"),
        h("div", { class: "wish" }, state.match.notes || "They haven't added any notes yet. Check back later.")));
    }
    if (state.phase !== "register") {
      const notes = h("textarea", { id: "f-notes", name: "notes", maxLength: 2000 });
      notes.value = state.me.notes;
      nodes.push(h("section", { class: "card" }, h("h2", {}, "What would you like?"),
        h("p", { class: "muted" }, "Only your Secret Santa can read this. You can update it at any time."),
        form("Save notes", [h("label", { htmlFor: "f-notes" }, "Gift ideas, sizes, things to avoid"), notes], async (values) => {
          await api("PUT", "/api/notes", values);
          flash = { message: "Your notes are saved." };
          await render();
        })));
    }
    nodes.push(h("section", { class: "card" }, h("h2", {}, `Who's taking part (${state.people.length})`),
      h("ul", { class: "people" }, state.people.map((person) => personRow(person, state)))));
    if (state.me.isOrganiser) nodes.push(organiserCard(state));
    nodes.push(passwordCard("Change password", "Optional."));
    root.replaceChildren(...nodes);
  }

  async function render() {
    if (!storage.get()) return loginView();
    try {
      dashboard(await api("GET", "/api/me"));
    } catch (problem) {
      if (problem.handled) return;
      root.replaceChildren(h("div", { class: "error", role: "alert" }, problem.message), act("Try again", render, ""));
    }
  }

  render();
})();
