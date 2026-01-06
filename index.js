const greetings = [
    "日本語で文を書いてみてください",
    "みずおのんでてください",
    "間違っても大丈夫です",
    "〜てください」を使ってみましょう",
    "水を飲んでください"
];

const textarea = document.querySelector(".textfield");
const fakePlaceholder = document.querySelector(".fake-placeholder");
const cycleInterval = 3000; // in ms

let index = 0;

fakePlaceholder.textContent = greetings[index];

function cycle_placeholder() {
    fakePlaceholder.classList.add("exit");

    setTimeout(() => {
        index = (index + 1) % greetings.length;
        fakePlaceholder.textContent = greetings[index];

        fakePlaceholder.classList.remove("exit");
        fakePlaceholder.classList.add("enter");

        requestAnimationFrame(() => {
            fakePlaceholder.classList.remove("enter");
        });
    }, 350);
}

setInterval(cycle_placeholder, cycleInterval);

// hide placeholder when typing
textarea.addEventListener("input", () => {
    fakePlaceholder.style.opacity = textarea.value ? "0" : "1";
});