// Per-language cycling placeholder examples (a mix of grammatical and
// ungrammatical sentences). The masthead "gram.en" is fixed -- "en" is the
// engine, not the language -- so it does not change with the selection.
const langs = {
    en: {
        greetings: [
            "the dog barks",
            "the cat chased the dog",
            "an dog barks",
            "the dogs barks",
            "me like dogs"
        ]
    },
    sv: {
        greetings: [
            "hunden skäller",
            "den stora hunden skäller",
            "en hus",
            "ett stor hus",
            "katten jagade jag"
        ]
    },
    ru: {
        greetings: [
            "собака гуляет",
            "девочка знает кота",
            "он студент",
            "мальчик читает книга",
            "я читает"
        ]
    }
};

let lang = "en";
let greetings = langs[lang].greetings;
let idx = 0;

const wrapper = document.querySelector(".textarea-wrapper");
const textfield = document.querySelector(".textfield");
const placeholder = document.querySelector(".fake-placeholder");
const counter_el = document.querySelector(".char-counter");
const highlights = document.querySelector(".highlights");
const popover = document.querySelector(".popover");
const status_el = document.querySelector(".status");
const lang_buttons = document.querySelectorAll(".lang-option");

const cycle_interval = 4000;
const capacity = 50;
const counter_threshold = capacity - 10; // only show the counter for the last 10 chars
const analyze_delay = 400; // ms

let typing = false;
let timeout = null;
let analyze_timer = null;
let current_violations = [];

placeholder.textContent = greetings[idx];

function cycle_placeholder() {
    if (typing) return;

    placeholder.classList.add("exit");

    timeout = setTimeout(() => {
        if (typing) return;

        idx = (idx + 1) % greetings.length;
        placeholder.textContent = greetings[idx];

        placeholder.classList.remove("exit");
        placeholder.classList.add("enter");

        requestAnimationFrame(() => {
            placeholder.classList.remove("enter");
        });
    }, 350);
}

setInterval(cycle_placeholder, cycle_interval);

function escape_html(s) {
    // quotes too, so the result is safe in attribute values as well as element content
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function set_status(text, cls) {
    status_el.textContent = text;
    status_el.className = "status" + (cls ? " " + cls : "");
}

function update_counter(length) {
    // counter: hidden until the input nears the cap, then fades in
    const near = length >= counter_threshold;
    counter_el.textContent = near ? `${length}/${capacity}` : "";
    counter_el.classList.toggle("visible", near);

    // placeholder: greeting only when empty; hidden while typing
    if (length > 0) {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }

        placeholder.classList.remove("exit", "enter");
        placeholder.classList.add("hidden");
    } else {
        placeholder.classList.remove("hidden");
        placeholder.textContent = greetings[idx];
    }
}

function render_highlights(text, violations) {
    const ordered = violations
        .map((v, i) => ({ v, i }))
        .filter((x) => Array.isArray(x.v.char_span))
        .sort((a, b) => a.v.char_span[0] - b.v.char_span[0]);

    let html = "";
    let cursor = 0;

    for (const { v, i } of ordered) {
        const [s, e] = v.char_span;

        if (s < cursor || e <= s) continue;

        html += escape_html(text.slice(cursor, s));
        html += `<span class="err" data-i="${i}">${escape_html(text.slice(s, e))}</span>`;
        cursor = e;
    }

    html += escape_html(text.slice(cursor));
    highlights.innerHTML = html;
}

function run_analysis() {
    const text = textfield.value;
    close_popover();

    if (!text.trim()) {
        highlights.innerHTML = "";
        current_violations = [];
        set_status("", "");
        return;
    }

    if (!window.GrammarEngine || typeof window.GrammarEngine.check !== "function") {
        set_status("engine not loaded — run: npm run build", "bad");
        return;
    }

    const result = window.GrammarEngine.check(text, lang);
    current_violations = result.violations || [];
    render_highlights(text, current_violations);

    switch (result.verdict) {
        case "grammatical":
            set_status("✓ looks grammatical", "ok");
            break;
        case "ungrammatical": {
            const n = current_violations.length;
            set_status(`✗ ${n} issue${n === 1 ? "" : "s"} — click the underline`, "bad");
            break;
        }
        case "unknown-word":
            set_status(`not analysed — unknown word: ${(result.unknown_words || []).join(", ")}`, "bad");
            break;
        default:
            set_status("couldn't analyse this one (out of coverage)", "");
    }
}

function open_popover(span) {
    const v = current_violations[Number(span.dataset.i)];

    if (!v) return;

    const fix_buttons = (v.fixes || [])
        .map((f) => `<button type="button">${escape_html(f)}</button>`)
        .join("");
    popover.innerHTML =
        `<div class="msg">${escape_html(v.message)}</div>` +
        `<div class="rule">${escape_html(v.rule)}</div>` +
        (fix_buttons ? `<div class="fixes">${fix_buttons}</div>` : "");

    popover.hidden = false;
    const wrap_rect = wrapper.getBoundingClientRect();
    const span_rect = span.getBoundingClientRect();
    popover.style.left = `${Math.max(0, span_rect.left - wrap_rect.left)}px`;
    popover.style.top = `${span_rect.bottom - wrap_rect.top + 6}px`;

    const buttons = popover.querySelectorAll(".fixes button");
    buttons.forEach((btn, i) => btn.addEventListener("click", () => apply_fix(v.fixes[i])));
}

function close_popover() {
    popover.hidden = true;
    popover.innerHTML = "";
}

function apply_fix(fix) {
    textfield.value = fix;
    typing = fix.length > 0;
    update_counter(fix.length);
    close_popover();
    run_analysis();
    textfield.focus();
}

textfield.addEventListener("input", (event) => {
    const length = event.target.value.length;
    typing = length > 0;
    update_counter(length);

    if (analyze_timer) clearTimeout(analyze_timer);

    analyze_timer = setTimeout(run_analysis, analyze_delay);
});

textfield.addEventListener("scroll", () => {
    highlights.scrollTop = textfield.scrollTop;
    highlights.scrollLeft = textfield.scrollLeft;
});

highlights.addEventListener("click", (event) => {
    const span = event.target.closest(".err");

    if (span) {
        event.stopPropagation();
        open_popover(span);
    }
});

document.addEventListener("click", (event) => {
    if (!popover.hidden && !popover.contains(event.target) && !event.target.closest(".err")) {
        close_popover();
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close_popover();
});

function set_language(next) {
    if (!langs[next] || next === lang) return;

    lang = next;
    greetings = langs[lang].greetings;
    idx = 0;

    lang_buttons.forEach((btn) => btn.classList.toggle("active", btn.dataset.lang === lang));

    // Refresh the placeholder if the field is empty, otherwise re-analyse in the
    // new language so existing text is re-checked against the switched grammar.
    if (!textfield.value.trim()) {
        placeholder.textContent = greetings[idx];
    } else {
        run_analysis();
    }
}

lang_buttons.forEach((btn) => btn.addEventListener("click", () => set_language(btn.dataset.lang)));
