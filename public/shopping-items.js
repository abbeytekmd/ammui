// Shopping list lines, shared by the server (imported by lib/nutrition.js and server.js) and the
// browser (loaded as a module by index.html, which puts these on window for app.js).
// A line is an optional amount, the item, and an optional note: "2 pints of | Milk | (semi-skimmed)".
// The item is what's matched to the saved ingredients and pictured.

const AMOUNT_WORDS = String.raw`an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|half(?=\s+(?:an?|of)\b)|few|couple|some|lots|plenty`;
const PACK_WORDS = 'g|grams?|kg|kilos?|ml|l|litres?|liters?|pints?|packs?|packets?|tins?|cans?|jars?|bottles?|bags?|boxes?|tubs?|cartons?|loaf|loaves|dozen|bunch(?:es)?|punnets?|heads?|bars?|blocks?|slices?|rolls?|x';

// Leading amounts and pack sizes, any number of them ("2 x 400g tins of"), and list bullets
const LEAD = new RegExp(String.raw`^(?:[\s.,/'*•·-]+|\d+(?:[.,/]\d+)?\s*(?:${PACK_WORDS})?\b[\s.,-]*|(?:${AMOUNT_WORDS}|${PACK_WORDS}|of)\b[\s.,-]*)`, 'i');
const LEAD_NUMBER = /^\d+(?:[.,/]\d+)?\s*/;
// Trailing notes and amounts: "(lean)", "x2", "- 12", "2", full stops
const TRAIL = /(?:\s*\([^)]*\)|[\s,–-]*(?:x\s*)?\d+\s*x?|[\s.!]+)*$/i;

const hasText = s => /[\p{L}\p{N}]/u.test(s);

// { before, item, after }: before + item + after is the line
export function splitShoppingLine(line) {
    let rest = String(line);
    let before = '';
    for (;;) {
        let strip = rest.match(LEAD)?.[0];
        // Never all of it: "Rolls" is an item, and in "6 rolls" only the 6 is an amount
        if (strip && !hasText(rest.slice(strip.length))) strip = rest.match(LEAD_NUMBER)?.[0];
        if (!strip || !hasText(rest.slice(strip.length))) break;
        before += strip;
        rest = rest.slice(strip.length);
    }
    const after = rest.match(TRAIL)[0];
    return { before, item: rest.slice(0, rest.length - after.length), after };
}

// Lowercase words, with a plural "s" dropped and accents removed, so "Eggs" and "egg" are the same item
const keyWords = text => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean).map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));

// What a line (or an ingredient's name) is, for matching: "2 pints of Milk" -> "milk"
export const shoppingItemKey = line => keyWords(splitShoppingLine(line).item).join(' ');
