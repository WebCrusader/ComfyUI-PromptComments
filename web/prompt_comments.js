import { app } from "../../scripts/app.js";

const VERSION = "v10";
const TOKEN = "# ";
const COMMENT_RE = /^(\s*)(#\s?|\/\/\s?)/;
const NODE_TYPE = "PromptComments";

console.info(`[prompt_comments] ${VERSION} loaded`);

const MIRRORED = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant",
  "lineHeight", "letterSpacing", "wordSpacing", "textAlign", "textIndent",
  "textTransform", "whiteSpace", "overflowWrap", "wordBreak", "tabSize",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "borderRadius", "boxSizing", "direction",
];

const CSS = `
.pcm-hl {
  position: absolute;
  margin: 0;
  border-style: solid;
  border-color: transparent;
  background: transparent;
  color: var(--input-text, #ddd);
  overflow: hidden;
  pointer-events: none;
  z-index: 2; /* above the textarea, so its own background/border still show */
}
.pcm-hl { visibility: hidden; } /* shown only while the textarea's text is hidden */
.pcm-hl .pcm-c { color: #ff5f56; font-style: italic; opacity: 0.9; }
/* Sibling of the overlay, not a child - otherwise it scrolls with the text. */
.pcm-count {
  position: absolute;
  z-index: 3;
  font: 10px/1 ui-monospace, monospace;
  font-style: normal;
  color: var(--descrip-text, #888);
  background: var(--comfy-input-bg, #222);
  padding: 2px 3px;
  border-radius: 3px;
  pointer-events: none;
}
/* Applied only once the overlay is proven to be working. Nothing here touches
   background, border or layout - only the glyph colour is handed to the overlay. */
textarea.pcm-live {
  color: transparent !important;
  caret-color: var(--input-text, #ddd);
}
`;

function injectStyle() {
  // Drop stylesheets from earlier versions so a cached one can't keep the
  // textarea transparent after an update.
  for (const el of document.querySelectorAll("style[id^='pcm-style']")) {
    if (el.id !== `pcm-style-${VERSION}`) el.remove();
  }
  if (document.getElementById(`pcm-style-${VERSION}`)) return;
  const el = document.createElement("style");
  el.id = `pcm-style-${VERSION}`;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/* ---------- comment parsing ---------- */

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Single left-to-right pass: the first marker wins, to its natural end.
// A `#` or `//` runs to the end of its line, a `/*` to the matching `*/` or,
// unterminated, to the end of the text. Everything downstream - the red
// painting and the counter - is derived from this one scan, and _mask() in
// __init__.py mirrors it, so what is painted red is exactly what Python
// removes. Change one, change both.
function scan(src) {
  const parts = [];
  let i = 0;
  let plain = "";
  const flush = () => {
    if (plain) {
      parts.push({ text: plain, comment: false });
      plain = "";
    }
  };
  while (i < src.length) {
    if (src.startsWith("/*", i)) {
      flush();
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      parts.push({ text: src.slice(i, stop), comment: true });
      i = stop;
    } else if (src[i] === "#" || src.startsWith("//", i)) {
      flush();
      let end = src.indexOf("\n", i);
      if (end === -1) end = src.length;
      parts.push({ text: src.slice(i, end), comment: true });
      i = end;
    } else {
      plain += src[i];
      i++;
    }
  }
  flush();
  return parts;
}

function highlight(src) {
  let out = "";
  for (const p of scan(src)) {
    out += p.comment
      ? `<span class="pcm-c">${esc(p.text)}</span>`
      : esc(p.text);
  }
  return out + "\n";
}

function liveCount(value) {
  const total = value.split("\n").filter((l) => l.trim()).length;
  // Comment spans collapse to MARK, line count preserved, exactly as _mask()
  // does in __init__.py - so a line holding only a comment cannot be counted
  // live, and an unterminated /* takes the rest of the prompt with it.
  let masked = "";
  for (const p of scan(value)) {
    if (!p.comment) {
      masked += p.text;
      continue;
    }
    const breaks = (p.text.match(/\n/g) || []).length;
    masked += "\u0000" + "\n\u0000".repeat(breaks);
  }
  const live = masked
    .split("\n")
    .filter((l) => l.replace(/\u0000/g, "").trim()).length;
  return `${live}/${total}`;
}

function activeLines(value, from, to) {
  const start = value.lastIndexOf("\n", from - 1) + 1;
  let end = to;
  if (end > from && value[end - 1] === "\n") end -= 1;
  const nl = value.indexOf("\n", end);
  return [start, nl === -1 ? value.length : nl];
}

function toggleComment(ta) {
  const value = ta.value;
  const selStart = ta.selectionStart;
  const selEnd = ta.selectionEnd;
  const collapsed = selStart === selEnd;

  const [start, end] = activeLines(value, selStart, selEnd);
  const lines = value.slice(start, end).split("\n");
  const filled = lines.filter((l) => l.trim());
  const allCommented = filled.length > 0 && filled.every((l) => COMMENT_RE.test(l));
  const blankOnly = filled.length === 0;

  const next = lines.map((line) => {
    if (!line.trim() && !blankOnly) return line;
    if (allCommented) return line.replace(COMMENT_RE, "$1");
    return line.replace(/^([ \t]*)/, `$1${TOKEN}`);
  });
  const replacement = next.join("\n");

  if (collapsed) {
    // Just a caret, no selection: keep it on the same character rather than
    // selecting the line. Shift it by however much the line grew or shrank.
    const delta = replacement.length - (end - start);
    const offset = selStart - start;
    const pos = start + Math.max(0, Math.min(replacement.length, offset + delta));
    ta.setRangeText(replacement, start, end, "end");
    ta.setSelectionRange(pos, pos);
  } else {
    // A real selection stays selected, so the shortcut can be pressed again.
    ta.setRangeText(replacement, start, end, "select");
  }

  ta.dispatchEvent(new Event("input", { bubbles: true })); // let Comfy store it
}

/* ---------- shortcut: bound to the document, not to one element ----------
   Capture phase, so it fires no matter which textarea instance the frontend
   actually put on screen, and regardless of who else listens.               */

document.addEventListener(
  "keydown",
  (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key !== "/" && e.code !== "Slash") return;
    const ta = e.target;
    if (ta?.tagName !== "TEXTAREA") return;
    if (ta.dataset.pcm !== "1") return; // only our nodes' editors
    e.preventDefault();
    e.stopPropagation();
    toggleComment(ta);
    ta.dispatchEvent(new CustomEvent("pcm-repaint"));
  },
  true
);

/* ---------- finding the textarea the user actually sees ---------- */

const isVisible = (el) =>
  el?.isConnected && el.offsetWidth > 0 && el.offsetHeight > 0;

function fromWidget(widget) {
  for (const el of [widget?.element, widget?.inputEl]) {
    if (!el) continue;
    if (el.tagName === "TEXTAREA" && isVisible(el)) return el;
    const inner = el.querySelector?.("textarea");
    if (isVisible(inner)) return inner;
  }
  return null;
}

// Fallback: write a sentinel through the widget API, then find whichever
// textarea in the document is showing it. Version-proof, because it uses the
// same path the frontend uses when loading a workflow.
function probe(widget) {
  // Writing to widget.value can mark the graph dirty and push an undo step, so
  // only probe when there is a real string to put back. During a workflow load
  // the value may still be undefined, and restoring that would clear the text.
  if (typeof widget.value !== "string") return null;
  const token = `\u200b pcm-${Math.random().toString(36).slice(2)}`;
  const original = widget.value;
  try {
    widget.value = token;
  } catch {
    return null;
  }
  let found = null;
  for (const ta of document.querySelectorAll("textarea")) {
    if (ta.value === token) {
      found = ta;
      break;
    }
  }
  try {
    widget.value = original;
  } catch {}
  if (found) found.value = original;
  return isVisible(found) ? found : null;
}

/* ---------- decoration ---------- */

const decorated = new WeakSet();
const registry = [];

function decorate(node, widget, ta) {
  if (decorated.has(ta)) return true;
  decorated.add(ta);
  ta.dataset.pcm = "1"; // enables the document-level shortcut
  ta.spellcheck = false;

  const host = ta.parentElement;
  if (!host) return true; // shortcut still works, colouring can't

  const hl = document.createElement("div");
  hl.className = "pcm-hl";

  const cnt = document.createElement("div");
  cnt.className = "pcm-count";

  const entry = { node, ta, hl, cnt, host, live: false, interacted: false };
  registry.push(entry);

  let disposed = false;
  let pending = false;
  const observers = [];

  // Everything routes through this. Once the node goes away the element tree is
  // torn down, and any observer that keeps reacting would spin forever.
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const o of observers) o.disconnect();
    clearInterval(poll);
    window.removeEventListener("resize", onResize);
    hl.remove();
    cnt.remove();
    ta.classList.remove("pcm-live");
    decorated.delete(ta);
    const i = registry.indexOf(entry);
    if (i > -1) registry.splice(i, 1);
    // The frontend can swap the textarea out from under us; re-arm hooking so
    // the replacement gets decorated. __pcmGiveUp, set only by the circuit
    // breaker below, is what makes a teardown permanent.
    if (node.__pcmHook === "done") node.__pcmHook = false;
  };
  entry.dispose = dispose;

  const alive = () =>
    !disposed && ta.isConnected && host.isConnected && document.contains(ta);

  if (getComputedStyle(host).position === "static") host.style.position = "relative";

  // Circuit breaker: if re-mounting the overlay keeps triggering another
  // removal, stop rather than fight the frontend forever.
  let mounts = 0;
  let windowStart = performance.now();
  const attach = () => {
    if (cnt.parentElement !== host) host.appendChild(cnt);
    if (hl.parentElement === host) return true;
    const now = performance.now();
    if (now - windowStart > 1000) {
      windowStart = now;
      mounts = 0;
    }
    if (++mounts > 20) {
      console.warn(
        "[prompt_comments] overlay will not stay mounted, disabling colouring for node",
        node.id
      );
      node.__pcmGiveUp = true; // do not re-hook, that is what got us here
      dispose();
      return false;
    }
    host.insertBefore(hl, ta);
    return true;
  };

  const place = () => {
    const r = ta.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const scale = ta.offsetWidth > 0 && r.width > 0 ? r.width / ta.offsetWidth : 1;
    hl.style.left = `${(r.left - hr.left) / scale}px`;
    hl.style.top = `${(r.top - hr.top) / scale}px`;
    hl.style.width = `${ta.offsetWidth}px`;
    hl.style.height = `${ta.offsetHeight}px`;
    const c = getComputedStyle(ta);
    hl.style.display = c.display === "none" ? "none" : "block";
    for (const p of MIRRORED) hl.style[p] = c[p];
    hl.style.borderColor = "transparent";

    const left = (r.left - hr.left) / scale;
    const top = (r.top - hr.top) / scale;
    cnt.style.right = `${host.offsetWidth - (left + ta.offsetWidth) + 6}px`;
    cnt.style.bottom = `${host.offsetHeight - (top + ta.offsetHeight) + 6}px`;
    cnt.style.display = hl.style.display;
  };

  const paint = () => {
    hl.innerHTML = highlight(ta.value);
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
    cnt.textContent = liveCount(ta.value);
  };

  // The textarea's text is hidden only while the overlay is aligned over it and
  // the element has proven live. Uncoloured text beats invisible text.
  // The overlay and the textarea's own glyphs must never be painted at the same
  // time, or the red comments show through the white text. Both flip together:
  // aligned -> overlay visible and text transparent; anything else -> the
  // reverse, so the worst case is uncoloured text rather than doubled text.
  const verify = () => {
    const rt = ta.getBoundingClientRect();
    const rh = hl.getBoundingClientRect();
    const ok =
      hl.isConnected &&
      hl.offsetWidth > 0 &&
      Math.abs(rt.left - rh.left) < 2 &&
      Math.abs(rt.top - rh.top) < 2 &&
      Math.abs(rt.width - rh.width) < 2;
    entry.live = ok;
    ta.classList.toggle("pcm-live", ok);
    hl.style.visibility = ok ? "visible" : "hidden";
    return ok;
  };

  const refresh = () => {
    if (!alive()) return dispose();
    if (!attach()) return;
    place();
    paint();
    verify();
  };
  entry.refresh = refresh;

  // Coalesce observer callbacks into one frame so a mutation storm can't
  // recurse through the microtask queue.
  const schedule = () => {
    if (disposed || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      refresh();
    });
  };

  const onResize = () => {
    if (!alive()) return dispose();
    place();
  };

  const touched = () => {
    entry.interacted = true;
    refresh();
  };
  ta.addEventListener("focus", touched);
  ta.addEventListener("pointerdown", touched);
  ta.addEventListener("input", () => {
    if (!alive()) return dispose();
    entry.interacted = true;
    paint();
    verify();
  });
  ta.addEventListener("pcm-repaint", () => {
    if (!alive()) return dispose();
    paint();
    verify();
  });
  ta.addEventListener("scroll", () => {
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  });

  const ro = new ResizeObserver(schedule);
  ro.observe(ta);
  observers.push(ro);

  const mo = new MutationObserver(() => {
    if (!alive()) return dispose();
    place();
    verify();
  });
  mo.observe(ta, { attributes: true, attributeFilter: ["style", "class"] });
  observers.push(mo);

  const hostMo = new MutationObserver(() => {
    if (!alive()) return dispose();
    if (hl.parentElement !== host) schedule();
  });
  hostMo.observe(host, { childList: true });
  observers.push(hostMo);

  window.addEventListener("resize", onResize);

  let last = ta.value;
  const poll = setInterval(() => {
    if (!alive()) return dispose();
    // Nothing worth reconciling while the tab is in the background or the node
    // is collapsed, and verify() costs two forced layout reads per tick. On a
    // graph with many of these nodes that competes with canvas panning for no
    // benefit. Both checks below are plain property reads, no layout.
    if (document.hidden || node.flags?.collapsed) return;
    if (ta.value !== last) {
      last = ta.value;
      paint();
    }
    if (hl.parentElement !== host) schedule();
    else verify();
  }, 400);

  if (widget) {
    widget.label = " ";
    if (widget.options) widget.options.hideLabel = true;
  }

  refresh();
  requestAnimationFrame(refresh);
  setTimeout(refresh, 400);
  return true;
}

// Tear down every overlay belonging to a node (removal, graph clear, reload).
function disposeNode(node) {
  for (const entry of [...registry]) {
    if (entry.node === node) entry.dispose?.();
  }
  node.__pcmHook = false; // re-adding the node should hook it afresh
}

// onNodeCreated, onAdded and onConfigure all want to hook the node, and on a
// workflow load all three fire. Without this guard each starts its own retry
// chain, so a node whose textarea never appears burns three chains of 60 tries
// and probes the widget on every one of them.
function hook(node) {
  if (node.__pcmGiveUp || node.__pcmHook) return;
  node.__pcmHook = "pending";
  retryHook(node, 60);
}

function retryHook(node, tries) {
  const widget = node.widgets?.find((w) => w.name === "text");
  if (widget) {
    const ta = fromWidget(widget) || probe(widget);
    if (ta) {
      node.__pcmHook = "done";
      decorate(node, widget, ta);
      return;
    }
  }
  if (tries > 0) {
    setTimeout(() => retryHook(node, tries - 1), 100);
    return;
  }
  node.__pcmHook = false; // let a later onAdded try again
  console.warn(
    "[prompt_comments] could not find the editor for node",
    node.id,
    "- run window.pcm.debug()"
  );
}

/* ---------- diagnostics ---------- */

window.pcm = {
  version: VERSION,
  registry,
  disposeAll() {
    for (const e of [...registry]) e.dispose?.();
    return "overlays torn down";
  },
  debug() {
    const all = [...document.querySelectorAll("textarea")].map((ta) => ({
      tagged: ta.dataset.pcm === "1",
      live: ta.classList.contains("pcm-live"),
      visible: isVisible(ta),
      size: `${ta.offsetWidth}x${ta.offsetHeight}`,
      color: getComputedStyle(ta).color,
      value: ta.value.slice(0, 40),
    }));
    console.table(all);
    console.table(
      registry.map((e) => ({
        node: e.node.id,
        interacted: e.interacted,
        live: e.live,
        overlayMounted: e.hl.isConnected,
        overlaySize: `${e.hl.offsetWidth}x${e.hl.offsetHeight}`,
      }))
    );
    return { textareas: all.length, decorated: registry.length };
  },
};

app.registerExtension({
  name: "prompt.comments",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    injectStyle();

    for (const h of ["onRemoved"]) {
      const original = nodeType.prototype[h];
      nodeType.prototype[h] = function () {
        disposeNode(this);
        return original?.apply(this, arguments);
      };
    }

    for (const h of ["onNodeCreated", "onAdded", "onConfigure"]) {
      const original = nodeType.prototype[h];
      nodeType.prototype[h] = function () {
        const r = original?.apply(this, arguments);
        if (h === "onNodeCreated") {
          const [w, ht] = this.size;
          this.size = [Math.max(w, 420), Math.max(ht, 260)];
        }
        hook(this);
        return r;
      };
    }
  },
});
