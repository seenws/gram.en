const greetings = [
    "日本語で文を書いてみてください",
    "みずおのんでてください",
    "間違っても大丈夫です",
    "〜てください」を使ってみましょう",
    "水を飲んでください"
];
let idx = 0;

const textarea = document.querySelector(".textfield");
const placeholder = document.querySelector(".fake-placeholder");
const cycleInterval = 4000; // in ms
const capacity = 50; // characters

let typing = false;
let timeout = null;

placeholder.textContent = greetings[idx];

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


textarea.addEventListener("input", (event) => {
    const value = event.target.value;
    const length = value.length;

    typing = length > 0;

    if (typing) {
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
});