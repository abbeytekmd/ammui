// Amounts and units of items, for the server: the same rules public/app.js uses for calories
// (keep the two in step).

const WEIGHT_GRAMS = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
const VOLUME_ML = { ml: 1, l: 1000, tsp: 4.92892, tbsp: 14.7868, cup: 236.588 };
const UNIT_ALIASES = {
    g: ['g', 'gram', 'grams', 'gramme', 'grammes', 'gr', 'gm', 'gms'],
    kg: ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms'],
    oz: ['oz', 'ounce', 'ounces'],
    lb: ['lb', 'lbs', 'pound', 'pounds'],
    ml: ['ml', 'mls', 'millilitre', 'millilitres', 'milliliter', 'milliliters'],
    l: ['l', 'litre', 'litres', 'liter', 'liters', 'ltr'],
    tsp: ['tsp', 'tsps', 'teaspoon', 'teaspoons'],
    tbsp: ['tbsp', 'tbsps', 'tbs', 'tbl', 'tablespoon', 'tablespoons'],
    cup: ['cup', 'cups'],
    each: ['', 'each', 'whole', 'item', 'items', 'x'],
};
const UNIT_KEYS = new Map(Object.entries(UNIT_ALIASES).flatMap(([key, names]) => names.map(n => [n, key])));
const PACK_WORDS = new Set(['pack', 'packet', 'tin', 'can', 'jar', 'bottle', 'bag', 'box', 'pot', 'tub', 'carton', 'pouch', 'bar']);
const UNICODE_FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };

// "Tablespoons" -> tbsp, "" -> each, "packets" -> packet
export function unitKey(unit) {
    const u = (unit || '').trim().toLowerCase().replace(/\.$/, '');
    if (UNIT_KEYS.has(u)) return UNIT_KEYS.get(u);
    if (/(ch|sh|x)es$/.test(u)) return u.slice(0, -2);
    if (u.length > 3 && u.endsWith('s') && !u.endsWith('ss')) return u.slice(0, -1);
    return u;
}

// "2", "0.5", "1,5", "1/2", "1 1/2", "1½", "2-3" (the middle) -> number, otherwise null
export function parseAmount(text) {
    const s = (text || '').trim().replace(/,/g, '.')
        .replace(/(\d)?\s*([½¼¾⅓⅔⅛])/g, (_, whole, f) => String((Number(whole) || 0) + UNICODE_FRACTIONS[f]));
    const one = part => {
        const m = part.trim().match(/^(?:(\d+(?:\.\d+)?)\s+)?(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?$/);
        if (!m) return null;
        const value = m[3] ? Number(m[2]) / Number(m[3]) : Number(m[2]);
        return (m[1] ? Number(m[1]) : 0) + value;
    };
    const range = s.split(/\s*(?:-|–|to)\s*/);
    if (range.length === 2) {
        const [a, b] = range.map(one);
        return a != null && b != null ? (a + b) / 2 : null;
    }
    const v = one(s);
    return v != null && Number.isFinite(v) ? v : null;
}

// Grams in one of this unit (a unitKey), or null if it can't be worked out
export function gramsPerOne(key, gramsPerUnit = {}) {
    if (WEIGHT_GRAMS[key]) return WEIGHT_GRAMS[key];
    if (gramsPerUnit[key] > 0) return gramsPerUnit[key];
    if (PACK_WORDS.has(key) && gramsPerUnit.pack > 0) return gramsPerUnit.pack;
    if (VOLUME_ML[key]) {
        const known = Object.keys(VOLUME_ML).find(v => gramsPerUnit[v] > 0);
        const density = known ? gramsPerUnit[known] / VOLUME_ML[known] : 1;
        return VOLUME_ML[key] * density;
    }
    return null;
}

// How many of an item an amount and unit is, against the item's own quantity for one person, or
// null if they can't be compared. An amount with no number counts as one of its unit.
export function quantityRatio(amount, unit, ownAmount, ownUnit, gramsPerUnit = {}) {
    const qty = text => parseAmount(text) ?? 1;
    const a = qty(amount), b = qty(ownAmount);
    if (!(b > 0)) return null;
    const ka = unitKey(unit), kb = unitKey(ownUnit);
    if (ka === kb) return a / b;
    const ga = gramsPerOne(ka, gramsPerUnit), gb = gramsPerOne(kb, gramsPerUnit);
    return ga && gb ? (a * ga) / (b * gb) : null;
}

// How many of each of its items one made of others can use
export const PART_MULTIPLES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5, 6];

// The nearest of those to n
export const nearestPartMultiple = n => PART_MULTIPLES.reduce((best, m) => Math.abs(m - n) < Math.abs(best - n) ? m : best, 1);
