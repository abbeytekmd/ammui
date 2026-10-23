// Calorie and macro (protein, carbs, fat) lookups for ingredients, from three sources:
//   cofid  UK basic foods: McCance and Widdowson's Composition of Foods (bundled, works offline)
//   off    UK packaged products: Open Food Facts (online, no key)
//   usda   USDA FoodData Central (online, needs a free key)
// Everything is reduced to what an ingredient stores: kcal and grams of protein, carbs, fat and
// alcohol per 100 g, plus the weight in grams of one of each unit the source knows (cup, tbsp, slice,
// each, pack...). Carbs are available carbohydrate, as on UK labels (fibre not included).
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { splitShoppingLine, shoppingItemKey } from '../public/shopping-items.js';

export const SOURCES = ['cofid', 'off', 'usda'];

export class NutritionError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.status = status;
    }
}

const round1 = n => Math.round(n * 10) / 10;

// { proteinPer100g, carbsPer100g, fatPer100g, alcoholPer100g }, each rounded, or null where it
// isn't known or can't be right (more than 100 g in 100 g)
const macrosOut = (protein, carbs, fat, alcohol) => {
    const clean = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? round1(v) : null);
    return { proteinPer100g: clean(protein), carbsPer100g: clean(carbs), fatPer100g: clean(fat), alcoholPer100g: clean(alcohol) };
};

// Grams of alcohol in 100 ml of a drink of this strength (% ABV); ethanol weighs 0.789 g/ml
const ALCOHOL_DENSITY = 0.789;
const RESULT_LIMIT = 25;

// ─── CoFID (bundled UK food table) ────────────────────────────────────────────

const COFID_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'cofid.json');
let cofidFoods = null; // [{ code, name, kcal, protein, carbs, fat, alcohol, words }] loaded on first search

// Lowercase words, with a plural "s" dropped so "onion" finds "Onions, raw"
const words = text => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean).map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));

function loadCofid() {
    if (!cofidFoods) {
        const data = JSON.parse(fs.readFileSync(COFID_PATH, 'utf8'));
        cofidFoods = data.foods.map(([code, name, kcal, protein, carbs, fat, alcohol]) => ({ code, name, kcal, protein, carbs, fat, alcohol, words: words(name) }));
    }
    return cofidFoods;
}

// Words people use that the table words differently
const COFID_SYNONYMS = { tinned: 'canned', tin: 'canned' };

// Edit distance, for the typo-tolerant second try ("brocolli" -> "broccoli")
function editDistance(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

const exactMatch = (term, word) => word.startsWith(term);
const closeMatch = (term, word) => {
    const allowed = term.length >= 7 ? 2 : term.length >= 4 ? 1 : 0;
    return allowed > 0 && Math.abs(term.length - word.length) <= allowed && editDistance(term, word) <= allowed;
};

// Every word searched for must start a word in the name (or, if nothing does, be a near miss
// of one). The food named first ("Onions" in "Onions, raw") ranks above foods that only mention
// it, raw above cooked, then shorter names.
function searchCofid(query) {
    const terms = words(query).map(t => COFID_SYNONYMS[t] || t);
    if (!terms.length) return [];
    const search = matches => {
        const scored = [];
        for (const food of loadCofid()) {
            if (!terms.every(t => food.words.some(w => matches(t, w)))) continue;
            const head = words(food.name.split(',')[0]);
            let score = 0;
            if (terms.every(t => head.some(w => matches(t, w)))) score += 20;
            if (head.length === terms.length) score += 10;
            if (food.words.includes('raw')) score += 5;
            score -= food.name.length / 20;
            scored.push({ food, score });
        }
        return scored;
    };
    let scored = search(exactMatch);
    if (!scored.length) scored = search((t, w) => exactMatch(t, w) || closeMatch(t, w));
    return scored.sort((a, b) => b.score - a.score).slice(0, RESULT_LIMIT)
        .map(({ food }) => ({ source: 'cofid', id: food.code, name: food.name, brand: '', kcalPer100g: food.kcal }));
}

function getCofidFood(code) {
    const food = loadCofid().find(f => f.code === code);
    if (!food) throw new NutritionError('That food was not found', 404);
    // CoFID has no portion weights
    return { source: 'cofid', id: food.code, name: food.name, kcalPer100g: food.kcal, ...macrosOut(food.protein, food.carbs, food.fat, food.alcohol), gramsPerUnit: {} };
}

// ─── Open Food Facts (packaged products sold in the UK) ───────────────────────

const OFF_SEARCH = 'https://search.openfoodfacts.org/search';
const OFF_PRODUCT = 'https://world.openfoodfacts.org/api/v2/product';
// Open Food Facts asks every app to name itself
const OFF_HEADERS = { 'User-Agent': 'AMMUI/1.0 (+https://github.com/abbeytekmd/ammui)' };
const OFF_FIELDS = 'code,product_name,generic_name,brands,nutriments,quantity,product_quantity,product_quantity_unit,serving_quantity,serving_quantity_unit';

async function offRequest(url, params) {
    try {
        return (await axios.get(url, { params, headers: OFF_HEADERS, timeout: 15000 })).data;
    } catch (err) {
        if (err.response?.status === 429) throw new NutritionError('Too many Open Food Facts searches. Wait a minute and try again.', 429);
        if (err.response?.status === 404) throw new NutritionError('That product was not found', 404);
        throw new NutritionError(`Open Food Facts lookup failed: ${err.message}`);
    }
}

const offBrand = p => (Array.isArray(p.brands) ? p.brands.join(', ') : p.brands || '').split(',')[0].trim();
const offName = p => (p.product_name || p.generic_name || '').trim();

// Nothing has more than about 900 kcal per 100 g (pure fat)
const MAX_KCAL = 900;

// Labels are typed in by people, and the kJ figure often lands in the kcal box: a kcal figure
// equal to the kJ one, or an impossible one, is worked out from kJ instead
function offKcal(nutriments = {}) {
    const num = v => (typeof v === 'number' && v >= 0 ? v : null);
    const kcal = num(nutriments['energy-kcal_100g']);
    const kj = num(nutriments['energy-kj_100g'] ?? nutriments.energy_100g); // energy_100g is in kJ
    const fromKj = kj != null && kj / 4.184 <= MAX_KCAL ? kj / 4.184 : null;
    if (kcal == null) return fromKj;
    const looksLikeKj = kj != null && kj > 0 && Math.abs(kcal - kj) <= kj * 0.05;
    if (looksLikeKj || kcal > MAX_KCAL) return fromKj;
    return kcal;
}

async function searchOff(query) {
    // The search takes Lucene-style syntax; keep the user's words as plain words
    const text = query.replace(/[:"()[\]{}^~*?\\/!+-]/g, ' ').trim();
    if (!text) return [];
    const data = await offRequest(OFF_SEARCH, {
        q: `${text} countries_tags:"en:united-kingdom"`,
        page_size: RESULT_LIMIT,
        fields: OFF_FIELDS,
    });
    const results = (data.hits || [])
        .map(p => {
            const kcal = offKcal(p.nutriments);
            return {
                source: 'off', id: String(p.code), name: offName(p), brand: offBrand(p),
                kcalPer100g: kcal == null ? null : round1(kcal),
                size: String(p.quantity || '').trim().slice(0, 30),
                doubtful: kcal != null && !kcalMatchesMacros(kcal, p.nutriments),
            };
        })
        .filter(p => p.name && p.kcalPer100g != null);
    // Figures that don't add up go last (sort is stable, so the search's order is kept otherwise)
    return results.sort((a, b) => a.doubtful - b.doubtful);
}

// Whether the label's calories roughly match its protein, carbs and fat (4, 4 and 9 kcal a
// gram, plus 2 for fibre, which UK labels count separately). Catches typing slips; a label
// missing any of these is given the benefit of the doubt.
function kcalMatchesMacros(kcal, n = {}) {
    const [p, c, f] = ['proteins_100g', 'carbohydrates_100g', 'fat_100g'].map(k => n[k]);
    if (![p, c, f].every(v => typeof v === 'number')) return true;
    const fibre = typeof n.fiber_100g === 'number' ? n.fiber_100g : 0;
    const expected = 4 * p + 4 * c + 9 * f + 2 * fibre;
    return Math.abs(kcal - expected) <= Math.max(20, 0.25 * Math.max(kcal, expected));
}

// Open Food Facts gives alcohol as % ABV; a label without it is taken as having none
function offAlcohol(nutriments = {}) {
    const abv = nutriments.alcohol_100g ?? nutriments.alcohol;
    return typeof abv === 'number' && abv >= 0 ? abv * ALCOHOL_DENSITY : 0;
}

// Grams (or ml, taken as grams) of a "420 g" / "1.5 kg" / "4x415 g" / "500ml" quantity, per item
function packGrams(quantity) {
    const m = String(quantity || '').toLowerCase().replace(',', '.')
        .match(/(?:(\d+)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*(kg|g|ml|cl|l)\b/);
    if (!m) return null;
    const factor = { kg: 1000, g: 1, l: 1000, cl: 10, ml: 1 }[m[3]];
    return Number(m[2]) * factor;
}

async function getOffFood(code) {
    if (!/^\d{1,30}$/.test(code)) throw new NutritionError('Invalid product code', 400);
    const data = await offRequest(`${OFF_PRODUCT}/${code}`, { fields: OFF_FIELDS });
    const p = data.product;
    if (!p || data.status === 0) throw new NutritionError('That product was not found', 404);
    const kcal = offKcal(p.nutriments);
    if (kcal == null) throw new NutritionError(`Open Food Facts has no calorie figure for "${offName(p) || code}"`, 404);
    const gramsPerUnit = {};
    // One pack (tin, packet, jar...): the size printed on it, or the total for a single item
    const unitIsWeight = u => !u || ['g', 'ml'].includes(String(u).toLowerCase());
    const pack = packGrams(p.quantity) ?? (p.product_quantity > 0 && unitIsWeight(p.product_quantity_unit) ? Number(p.product_quantity) : null);
    if (pack > 0) gramsPerUnit.pack = round1(pack);
    if (p.serving_quantity > 0 && unitIsWeight(p.serving_quantity_unit)) gramsPerUnit.serving = round1(Number(p.serving_quantity));
    const brand = offBrand(p);
    return {
        source: 'off', id: String(p.code),
        name: brand && !offName(p).toLowerCase().includes(brand.toLowerCase()) ? `${offName(p)} (${brand})` : offName(p),
        kcalPer100g: round1(kcal),
        ...macrosOut(p.nutriments?.proteins_100g, p.nutriments?.carbohydrates_100g, p.nutriments?.fat_100g, offAlcohol(p.nutriments)),
        gramsPerUnit,
    };
}

// ─── Shopping list pictures (Open Food Facts) ─────────────────────────────────

// Supermarkets whose own-brand products are preferred, with their Open Food Facts brand tags
export const SUPERMARKETS = [
    { id: 'aldi', name: 'Aldi', brands: ['aldi'] },
    { id: 'asda', name: 'Asda', brands: ['asda'] },
    { id: 'co-op', name: 'Co-op', brands: ['co-op', 'the-co-operative'] },
    { id: 'iceland', name: 'Iceland', brands: ['iceland'] },
    { id: 'lidl', name: 'Lidl', brands: ['lidl'] },
    { id: 'm-s', name: 'M&S', brands: ['m-s', 'marks-spencer'] },
    { id: 'morrisons', name: 'Morrisons', brands: ['morrisons'] },
    { id: 'ocado', name: 'Ocado', brands: ['ocado'] },
    { id: 'sainsburys', name: "Sainsbury's", brands: ['sainsbury-s'] },
    { id: 'tesco', name: 'Tesco', brands: ['tesco'] },
    { id: 'waitrose', name: 'Waitrose', brands: ['waitrose'] },
];

// What to search for on a shopping list line: "2 pints of Milk" -> "milk", "500g mince (lean)" -> "mince"
export const shoppingSearchText = line => splitShoppingLine(line).item.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean).join(' ');

// A line's item, as matched (picks are saved under this): "2 pints of Milk" -> "milk"
export { shoppingItemKey };

// The cache key for a line's automatic picture: its item plus the supermarket
export const shoppingProductKey = (line, supermarket = '') => `${supermarket}|${shoppingItemKey(line)}`;

const shoppingProductOut = p => ({ code: String(p.code), name: offName(p), brand: offBrand(p), image: p.image_front_small_url });

// Search hits with a picture, best first: [{ p, score, allWords }]. Products with every word of the
// item come first ("toilet roll" isn't pictured by "Fig Rolls"), and of those the ones named just
// the item ("Milk") rank above ones that only mention it ("Chocolate Milk"), then the more often scanned.
async function shoppingHits(text, brandTags) {
    const terms = words(text);
    const brandFilter = brandTags.length ? ` (${brandTags.map(b => `brands_tags:"${b}"`).join(' OR ')})` : '';
    const data = await offRequest(OFF_SEARCH, {
        q: `${text} countries_tags:"en:united-kingdom"${brandFilter}`,
        page_size: 40,
        fields: 'code,product_name,generic_name,brands,image_front_small_url,unique_scans_n',
    });
    const hits = [];
    for (const p of data.hits || []) {
        if (!p.image_front_small_url || !offName(p)) continue;
        const name = words(offName(p));
        const found = terms.filter(t => name.includes(t)).length;
        let score = 50 * (found / terms.length) - (name.length - found) * 10;
        if (found === terms.length && name.length === terms.length) score += 5;
        score += Math.log10(1 + (p.unique_scans_n || 0)) * 3;
        hits.push({ p, score, allWords: found === terms.length });
    }
    return hits.sort((a, b) => b.allWords - a.allWords || b.score - a.score);
}

// With a supermarket, its own product wins unless it's a much worse match than anyone's:
// "Whole Milk" (one extra word) for "milk", but not "Coconut Milk Drink".
const OWN_BRAND_MARGIN = 12;

const searchableText = line => shoppingSearchText(line).replace(/[:"()[\]{}^~*?\/!+-]/g, ' ').trim();

async function ownAndAnyHits(line, supermarket) {
    const text = searchableText(line);
    if (!text) return [[], []];
    const brands = SUPERMARKETS.find(s => s.id === supermarket)?.brands || [];
    return Promise.all([brands.length ? shoppingHits(text, brands) : [], shoppingHits(text, [])]);
}

// The packaged product most like a shopping list item, with a picture: { code, name, brand, image },
// or null if nothing has every word of it.
export async function findShoppingProduct(line, supermarket = '') {
    const [own, any] = (await ownAndAnyHits(line, supermarket)).map(hits => hits.find(h => h.allWords));
    const best = own && (!any || own.score >= any.score - OWN_BRAND_MARGIN) ? own : any;
    return best ? shoppingProductOut(best.p) : null;
}

// Every product a search finds, for choosing a different picture: the supermarket's own first
// where they match as well, then the rest. [{ code, name, brand, image }]
export async function searchShoppingProducts(query, supermarket = '') {
    const [own, any] = await ownAndAnyHits(query, supermarket);
    const merged = [...own.map(h => ({ ...h, score: h.score + OWN_BRAND_MARGIN })), ...any]
        .sort((a, b) => b.allWords - a.allWords || b.score - a.score);
    const seen = new Set();
    return merged.filter(h => !seen.has(h.p.code) && seen.add(h.p.code)).slice(0, 40).map(h => shoppingProductOut(h.p));
}

// ─── USDA FoodData Central ────────────────────────────────────────────────────

const FDC_API = 'https://api.nal.usda.gov/fdc/v1';

// Basic foods first; branded products swamp the results for plain ingredients like "onion"
const GENERIC_TYPES = ['Foundation', 'SR Legacy', 'Survey (FNDDS)'];

// Energy can be listed under any of these nutrient ids, best first
const KCAL_IDS = [1008, 2048, 2047];
const KJ_ID = 1062;
const PROTEIN_ID = 1003;
const FAT_IDS = [1004, 1085]; // total lipid, then total fat (NLEA)
const CARBS_BY_DIFFERENCE_ID = 1005; // includes fibre
const CARBS_BY_SUMMATION_ID = 1050; // sugars and starch, so no fibre
const FIBRE_ID = 1079;
const ALCOHOL_ID = 1018; // alcohol, ethyl

// body: sent as JSON with a POST (the search takes its list of data types far more reliably
// that way than in the query string); otherwise a GET
async function fdcRequest(apiKey, path, body) {
    if (!apiKey) throw new NutritionError('Add a USDA FoodData Central API key in Settings → Integrations first.', 400);
    try {
        const resp = await axios({
            method: body ? 'post' : 'get',
            url: `${FDC_API}${path}`,
            params: { api_key: apiKey },
            data: body,
            timeout: 15000,
        });
        return resp.data;
    } catch (err) {
        const code = err.response?.data?.error?.code;
        if (code === 'API_KEY_INVALID' || code === 'API_KEY_MISSING') throw new NutritionError('The USDA API key was rejected. Check it in Settings → Integrations.', 400);
        if (code === 'OVER_RATE_LIMIT' || err.response?.status === 429) throw new NutritionError('Too many USDA lookups this hour. Try again later.', 429);
        if (err.response?.status === 404) throw new NutritionError('That food was not found', 404);
        const detail = err.response?.data?.error?.message || err.response?.data?.message || err.message;
        throw new NutritionError(`USDA lookup failed: ${detail}`);
    }
}

// Search results list nutrients as { nutrientId, value }; food details as { nutrient: { id }, amount }
const fdcValue = (nutrients, id) => {
    const n = nutrients.find(n => (n.nutrientId ?? n.nutrient?.id) === id);
    const v = n?.value ?? n?.amount;
    return typeof v === 'number' ? v : null;
};

function fdcKcal(nutrients = []) {
    const value = id => fdcValue(nutrients, id);
    for (const id of KCAL_IDS) {
        const v = value(id);
        if (v != null) return v;
    }
    const kj = value(KJ_ID);
    return kj == null ? null : kj / 4.184;
}

// USDA counts fibre in its carbohydrate; it's taken off to match UK figures
function fdcMacros(nutrients = []) {
    const value = id => fdcValue(nutrients, id);
    const byDifference = value(CARBS_BY_DIFFERENCE_ID);
    const carbs = byDifference != null ? Math.max(0, byDifference - (value(FIBRE_ID) ?? 0)) : value(CARBS_BY_SUMMATION_ID);
    // Foods with no alcohol mostly leave it out rather than list 0
    return macrosOut(value(PROTEIN_ID), carbs, FAT_IDS.map(value).find(v => v != null), value(ALCOHOL_ID) ?? 0);
}

async function searchUsda(apiKey, query, branded) {
    const data = await fdcRequest(apiKey, '/foods/search', {
        query,
        dataType: branded ? [...GENERIC_TYPES, 'Branded'] : GENERIC_TYPES,
        pageSize: RESULT_LIMIT,
    });
    return (data.foods || [])
        .map(f => ({ source: 'usda', id: String(f.fdcId), name: f.description, brand: f.brandName || f.brandOwner || '', kcalPer100g: fdcKcal(f.foodNutrients) }))
        .filter(f => f.kcalPer100g != null)
        .map(f => ({ ...f, kcalPer100g: round1(f.kcalPer100g) }));
}

// Which of our units a portion's wording describes, and how good a match for "one" it is
// (lower is better). "each" is a single item: a medium one beats a whole one beats a large one.
const PORTION_UNITS = [
    [/\bcups?\b/, 'cup'],
    [/\b(tbsp|tablespoons?)\b/, 'tbsp'],
    [/\b(tsp|teaspoons?)\b/, 'tsp'],
    [/\bslices?\b/, 'slice'],
    [/\bcloves?\b/, 'clove'],
    [/\b(pieces?|pcs?)\b/, 'piece'],
];
const EACH_WORDS = [[/\bmedium\b/, 1], [/\b(whole|each|item)\b/, 2], [/\blarge\b/, 4], [/\bsmall\b/, 5]];
const IGNORED_UNITS = new Set(['undetermined', 'racc', '']);

function unitForPortion(text, measureName) {
    for (const [re, unit] of PORTION_UNITS) if (re.test(text)) return { unit, rank: 0 };
    if (/fl\.? ?oz|\boz\b|\blbs?\b|\bquantity not specified\b|\bserving\b/.test(text)) return null;
    for (const [re, rank] of EACH_WORDS) if (re.test(text)) return { unit: 'each', rank };
    // Foundation foods name the item itself ("1 Onion"): that's one of it
    if (measureName && !IGNORED_UNITS.has(measureName)) return { unit: 'each', rank: 3 };
    return null;
}

// Leading count in "1 cup" / "10 rings" / "1/2 cup"
function leadingAmount(text) {
    const m = text.match(/^\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?/);
    if (!m) return null;
    return m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
}

// { unit: grams for one } from a food's portions (and, for branded foods, its serving size)
function fdcGramsPerUnit(food) {
    const best = {}; // unit -> { grams, rank }
    const offer = (unit, rank, grams) => {
        if (!(grams > 0)) return;
        if (!best[unit] || rank < best[unit].rank) best[unit] = { grams: round1(grams), rank };
    };
    for (const p of food.foodPortions || []) {
        const measureName = (p.measureUnit?.name || '').toLowerCase();
        const modifier = /^\d+$/.test(p.modifier || '') ? '' : (p.modifier || ''); // FNDDS puts a code here
        const description = p.portionDescription || '';
        const text = [IGNORED_UNITS.has(measureName) ? '' : measureName, modifier, description].join(' ').toLowerCase();
        const match = unitForPortion(text, measureName);
        if (!match) continue;
        const count = p.amount || leadingAmount(description) || 1;
        offer(match.unit, match.rank, p.gramWeight / count);
    }
    // Branded: "1 BAGEL" / "2 tbsp" = servingSize g
    const servingUnit = (food.servingSizeUnit || '').toLowerCase();
    if (food.servingSize > 0 && ['g', 'grm', 'gram', 'grams'].includes(servingUnit)) {
        const household = (food.householdServingFullText || '').toLowerCase();
        const match = household && unitForPortion(household, '');
        const count = leadingAmount(household) || 1;
        offer(match ? match.unit : 'each', match ? match.rank : 6, food.servingSize / count);
    }
    return Object.fromEntries(Object.entries(best).map(([unit, { grams }]) => [unit, grams]));
}

async function getUsdaFood(apiKey, fdcId) {
    if (!/^\d+$/.test(fdcId)) throw new NutritionError('Invalid food id', 400);
    const food = await fdcRequest(apiKey, `/food/${fdcId}`);
    const kcal = fdcKcal(food.foodNutrients);
    if (kcal == null) throw new NutritionError(`USDA has no calorie figure for "${food.description}"`, 404);
    return {
        source: 'usda', id: String(food.fdcId), name: food.description, kcalPer100g: round1(kcal),
        ...fdcMacros(food.foodNutrients), gramsPerUnit: fdcGramsPerUnit(food),
    };
}

// ─── Entry points ─────────────────────────────────────────────────────────────

// [{ source, id, name, brand, kcalPer100g }], skipping foods with no energy figure.
// branded only applies to USDA (the other sources are basic foods or products already).
export async function searchFoods(source, query, { usdaKey, branded = false } = {}) {
    if (source === 'cofid') return searchCofid(query);
    if (source === 'off') return searchOff(query);
    if (source === 'usda') return searchUsda(usdaKey, query, branded);
    throw new NutritionError('Unknown food source', 400);
}

// { source, id, name, kcalPer100g, proteinPer100g, carbsPer100g, fatPer100g, alcoholPer100g, gramsPerUnit }
// (a macro is null where the source doesn't give it)
export async function getFood(source, id, { usdaKey } = {}) {
    if (source === 'cofid') return getCofidFood(id);
    if (source === 'off') return getOffFood(id);
    if (source === 'usda') return getUsdaFood(usdaKey, id);
    throw new NutritionError('Unknown food source', 400);
}
