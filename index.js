const greetings = [
    "the dog barks",
    "the cat chased the dog",
    "an dog barks",
    "the dogs barks",
    "me like dogs"
];
let idx = 0;

const wrapper = document.querySelector(".textarea-wrapper");
const textfield = document.querySelector(".textfield");
const placeholder = document.querySelector(".fake-placeholder");
const highlights = document.querySelector(".highlights");
const popover = document.querySelector(".popover");
const statusEl = document.querySelector(".status");

const cycleInterval = 4000; // in ms
const capacity = 50; // characters
const analyzeDelay = 400; // debounce, in ms

let typing = false;
let timeout = null;
let analyzeTimer = null;
let currentViolations = [];

placeholder.textContent = greetings[idx];

// --- cycling placeholder (unchanged behaviour) ----------------------------

function cycle_placeholder() {
    if (typing) return;

    placeholder.classList.add("exit");

    timeout = setTimeout(() => {
        if (typing) return; // guards against cycle race condition

        idx = (idx + 1) % greetings.length;
        placeholder.textContent = greetings[idx];

        placeholder.classList.remove("exit");
        placeholder.classList.add("enter");

        requestAnimationFrame(() => {
            placeholder.classList.remove("enter");
        });
    }, 350);
}

setInterval(cycle_placeholder, cycleInterval);

// --- helpers --------------------------------------------------------------

function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status" + (cls ? " " + cls : "");
}

function updateCounter(length) {
    if (length > 0) {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
        placeholder.classList.remove("exit", "enter");
        placeholder.classList.add("counter");
        placeholder.textContent = `(${length}/${capacity})`;
    } else {
        placeholder.classList.remove("counter");
        placeholder.textContent = greetings[idx];
    }
}

// Rebuild the overlay so each error's character span is wrapped in a clickable
// underline; the rest of the text stays (transparent) for exact alignment.
function renderHighlights(text, violations) {
    const ordered = violations
        .map((v, i) => ({ v, i }))
        .filter((x) => Array.isArray(x.v.charSpan))
        .sort((a, b) => a.v.charSpan[0] - b.v.charSpan[0]);

    let html = "";
    let cursor = 0;
    for (const { v, i } of ordered) {
        const [s, e] = v.charSpan;
        if (s < cursor || e <= s) continue; // skip overlaps / empties
        html += escapeHtml(text.slice(cursor, s));
        html += `<span class="err" data-i="${i}">${escapeHtml(text.slice(s, e))}</span>`;
        cursor = e;
    }
    html += escapeHtml(text.slice(cursor));
    highlights.innerHTML = html;
}

function runAnalysis() {
    const text = textfield.value;
    closePopover();

    if (!text.trim()) {
        highlights.innerHTML = "";
        currentViolations = [];
        setStatus("", "");
        return;
    }
    if (!window.GrammarEngine || typeof window.GrammarEngine.check !== "function") {
        setStatus("engine not loaded — run: npm run build", "bad");
        return;
    }

    const result = window.GrammarEngine.check(text);
    currentViolations = result.violations || [];
    renderHighlights(text, currentViolations);

    switch (result.verdict) {
        case "grammatical":
            setStatus("✓ looks grammatical", "ok");
            break;
        case "ungrammatical": {
            const n = currentViolations.length;
            setStatus(`✗ ${n} issue${n === 1 ? "" : "s"} — click the underline`, "bad");
            break;
        }
        case "unknown-word":
            setStatus(`not analysed — unknown word: ${(result.unknownWords || []).join(", ")}`, "bad");
            break;
        default:
            setStatus("couldn't analyse this one (out of coverage)", "");
    }
}

// --- popover --------------------------------------------------------------

function openPopover(span) {
    const v = currentViolations[Number(span.dataset.i)];
    if (!v) return;

    const fixButtons = (v.fixes || [])
        .map((f) => `<button type="button">${escapeHtml(f)}</button>`)
        .join("");
    popover.innerHTML =
        `<div class="msg">${escapeHtml(v.message)}</div>` +
        `<div class="rule">${escapeHtml(v.rule)}</div>` +
        (fixButtons ? `<div class="fixes">${fixButtons}</div>` : "");

    popover.hidden = false;
    const wrapRect = wrapper.getBoundingClientRect();
    const spanRect = span.getBoundingClientRect();
    popover.style.left = `${Math.max(0, spanRect.left - wrapRect.left)}px`;
    popover.style.top = `${spanRect.bottom - wrapRect.top + 6}px`;

    const buttons = popover.querySelectorAll(".fixes button");
    buttons.forEach((btn, i) => btn.addEventListener("click", () => applyFix(v.fixes[i])));
}

function closePopover() {
    popover.hidden = true;
    popover.innerHTML = "";
}

function applyFix(fix) {
    textfield.value = fix;
    typing = fix.length > 0;
    updateCounter(fix.length);
    closePopover();
    runAnalysis();
    textfield.focus();
}

// --- events ---------------------------------------------------------------

textfield.addEventListener("input", (event) => {
    const length = event.target.value.length;
    typing = length > 0;
    updateCounter(length);

    if (analyzeTimer) clearTimeout(analyzeTimer);
    analyzeTimer = setTimeout(runAnalysis, analyzeDelay);
});

textfield.addEventListener("scroll", () => {
    highlights.scrollTop = textfield.scrollTop;
    highlights.scrollLeft = textfield.scrollLeft;
});

highlights.addEventListener("click", (event) => {
    const span = event.target.closest(".err");
    if (span) {
        event.stopPropagation();
        openPopover(span);
    }
});

document.addEventListener("click", (event) => {
    if (!popover.hidden && !popover.contains(event.target) && !event.target.closest(".err")) {
        closePopover();
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePopover();
});
