import { app } from "../../scripts/app.js";

const VERSION = "v11";
const TOKEN = "# ";
// Matches only what scan() below would actually treat as a comment: a marker at
// the start of the line followed by whitespace or nothing. `#hashtag` is text,
// so the toggle will not "uncomment" it.
const COMMENT_RE = /^([ \t]*)(?:#|\/\/)(?=[ \t]|$)[ \t]?/;
const NODE_TYPE = "PromptComments";

console.debug(`[prompt_comments] ${VERSION} loaded`);

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

/* ---------- comment parsing ----------
   test_strip_comments.py lifts everything between the two scanner markers below
   and runs it against the same corpus as the Python filter. Keep the markers in
   place, and keep this region free of anything that touches the DOM.        */

/* pcm:scanner:begin */

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Stands in for removed comment text. The same character as MARK in
// nodes.py, and stripped from the input for the same reason: a literal
// NUL in the prompt would otherwise be indistinguishable from a comment
// that has already been taken out.
const MARK = "\u0000";

// The whitespace that can sit either side of a marker. An explicit set, not
// \s: nodes.py uses the same six characters, and Python's idea of whitespace
// is wider than JavaScript's. Change one, change both.
const WS = " \t\r\n\f\v";

// A marker only counts if it starts the text or follows whitespace. This is
// what keeps `C#`, `#hashtag` and `https://...` out of the scanner.
const opens = (src, i) => i === 0 || WS.includes(src[i - 1]);

// ...and `#` / `//` also need whitespace or the end of the text after them, so
// `# note` is a comment and `#note` is a hashtag. `/*` is exempt: it carries
// its own terminator, so `/*parked` stays usable.
const closes = (src, i) => i >= src.length || WS.includes(src[i]);

// Single left-to-right pass: the first marker wins, to its natural end.
// A `#` or `//` runs to the end of its line, a `/*` to the matching `*/` or,
// unterminated, to the end of the text. Everything downstream - the red
// painting and the counter - is derived from this one scan, and _mask() in
// nodes.py mirrors it, so what is painted red is exactly what Python
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
    if (src.startsWith("/*", i) && opens(src, i)) {
      flush();
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      parts.push({ text: src.slice(i, stop), comment: true });
      i = stop;
    } else if (
      opens(src, i) &&
      ((src[i] === "#" && closes(src, i + 1)) ||
        (src.startsWith("//", i) && closes(src, i + 2)))
    ) {
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
  value = value.split(MARK).join("");
  const total = value.split("\n").filter((l) => l.trim()).length;
  // Comment spans collapse to MARK, line count preserved, exactly as _mask()
  // does in nodes.py - so a line holding only a comment cannot be counted
  // live, and an unterminated /* takes the rest of the prompt with it.
  let masked = "";
  for (const p of scan(value)) {
    if (!p.comment) {
      masked += p.text;
      continue;
    }
    const breaks = (p.text.match(/\n/g) || []).length;
    masked += MARK + `\n${MARK}`.repeat(breaks);
  }
  const live = masked
    .split("\n")
    .filter((l) => l.split(MARK).join("").trim()).length;
  return `${live}/${total}`;
}

/* pcm:scanner:end */

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
  let composing = false;
  let onScreen = true;
  const observers = [];
  // Every listener this decoration adds, to the textarea and to window, goes
  // through this signal so dispose() can drop all of them at once. The frontend
  // recycles textareas; without this each decoration would leave its handlers
  // behind, pinning the node and overlay alive and firing alongside the next.
  const listeners = new AbortController();
  const signal = listeners.signal;
  // Declared before dispose() closes over them. A dispose triggered during
  // setup would otherwise hit the temporal dead zone instead of tearing down.
  let poll = null;
  let patchedPosition = null;

  // Everything routes through this. Once the node goes away the element tree is
  // torn down, and any observer that keeps reacting would spin forever.
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const o of observers) o.disconnect();
    if (poll !== null) clearInterval(poll);
    listeners.abort();
    hl.remove();
    cnt.remove();
    ta.classList.remove("pcm-live");
    if (patchedPosition !== null) host.style.position = patchedPosition;
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

  // Remember what was there so dispose() hands the host back untouched.
  if (getComputedStyle(host).position === "static") {
    patchedPosition = host.style.position;
    host.style.position = "relative";
  }

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

  // A textarea takes its scrollbar out of its own content box, so as soon as
  // the prompt is long enough to scroll its text wraps earlier than the
  // overlay's would. Matching the padding plus that scrollbar's width keeps the
  // two wrapping identically - otherwise the red drifts onto the wrong words
  // while verify() still sees two correctly aligned boxes.
  let padRight = 0;
  let borderX = 0;
  let gutter = -1;
  const syncGutter = () => {
    const sb = Math.max(0, ta.offsetWidth - ta.clientWidth - borderX);
    if (sb === gutter) return;
    gutter = sb;
    hl.style.paddingRight = `${padRight + sb}px`;
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

    padRight = parseFloat(c.paddingRight) || 0;
    borderX =
      (parseFloat(c.borderLeftWidth) || 0) + (parseFloat(c.borderRightWidth) || 0);
    gutter = -1; // paddingRight was just overwritten by the mirror loop
    syncGutter();

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
    syncGutter(); // a scrollbar can appear on any keystroke
  };

  // The textarea's text is hidden only while the overlay is aligned over it and
  // the element has proven live. Uncoloured text beats invisible text.
  // The overlay and the textarea's own glyphs must never be painted at the same
  // time, or the red comments show through the white text. Both flip together:
  // aligned -> overlay visible and text transparent; anything else -> the
  // reverse, so the worst case is uncoloured text rather than doubled text.
  // An IME composition counts as "anything else": the preedit string is drawn
  // by the textarea and has no counterpart in the overlay, so hiding the
  // textarea's glyphs would make the user type into nothing.
  const verify = () => {
    const rt = ta.getBoundingClientRect();
    const rh = hl.getBoundingClientRect();
    const ok =
      !composing &&
      hl.isConnected &&
      hl.offsetWidth > 0 &&
      Math.abs(rt.left - rh.left) < 2 &&
      Math.abs(rt.top - rh.top) < 2 &&
      Math.abs(rt.width - rh.width) < 2;
    entry.live = ok;
    // Only write when the value actually changes: the MutationObserver below
    // watches this very attribute, and a self-inflicted record costs two forced
    // layouts to discover nothing happened.
    if (ta.classList.contains("pcm-live") !== ok) {
      ta.classList.toggle("pcm-live", ok);
    }
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
  const on = (type, fn) => ta.addEventListener(type, fn, { signal });

  on("focus", touched);
  on("pointerdown", touched);
  on("input", () => {
    if (!alive()) return dispose();
    entry.interacted = true;
    paint();
    verify();
  });
  on("pcm-repaint", () => {
    if (!alive()) return dispose();
    paint();
    verify();
  });
  on("scroll", () => {
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  });
  // Hand the glyphs back for the duration of a composition, otherwise the
  // candidate string is typed into transparent text.
  on("compositionstart", () => {
    composing = true;
    verify();
  });
  on("compositionend", () => {
    composing = false;
    if (!alive()) return dispose();
    paint();
    verify();
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

  // Panning a node off the canvas should stop it costing anything per tick.
  const io = new IntersectionObserver((records) => {
    const was = onScreen;
    onScreen = records.some((r) => r.isIntersecting);
    if (onScreen && !was) schedule(); // catch up on whatever changed meanwhile
  });
  io.observe(ta);
  observers.push(io);

  window.addEventListener("resize", onResize, { signal });

  let last = ta.value;
  poll = setInterval(() => {
    if (!alive()) return dispose();
    // Nothing worth reconciling while the tab is in the background, the node is
    // collapsed, or it has been panned off screen - and verify() costs two
    // forced layout reads per tick. On a graph with many of these nodes that
    // competes with canvas panning for no benefit. All three checks below are
    // plain property reads, no layout.
    if (document.hidden || !onScreen || node.flags?.collapsed) return;
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
