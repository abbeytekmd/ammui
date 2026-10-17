// Calorie lookups from USDA FoodData Central (https://fdc.nal.usda.gov/api-guide).
// Everything is reduced to what an ingredient stores: kcal per 100 g, plus the weight in grams
// of one of each household unit the food lists (cup, tbsp, tsp, slice, clove, each...).
import axios from 'axios';

const FDC_API = 'https://api.nal.usda.gov/fdc/v1';

// Basic foods first; branded products swamp the results for plain ingredients like "onion"
const GENERIC_TYPES = ['Foundation', 'SR Legacy', 'Survey (FNDDS)'];

// Energy can be listed under any of these nutrient ids, best first
const KCAL_IDS = [1008, 2048, 2047];
const KJ_ID = 1062;

export class NutritionError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.status = status;
    }
}

// body: sent as JSON with a POST (the search takes its list of data types far more reliably
// that way than in the query string); otherwise a GET
async function fdcRequest(apiKey, path, body) {
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
function kcalPer100g(nutrients = []) {
    const value = id => {
        const n = nutrients.find(n => (n.nutrientId ?? n.nutrient?.id) === id);
        const v = n?.value ?? n?.amount;
        return typeof v === 'number' ? v : null;
    };
    for (const id of KCAL_IDS) {
        const v = value(id);
        if (v != null) return v;
    }
    const kj = value(KJ_ID);
    return kj == null ? null : kj / 4.184;
}

const round1 = n => Math.round(n * 10) / 10;

// [{ fdcId, name, type, brand, kcalPer100g }], skipping foods with no energy figure
export async function searchFoods(apiKey, query, { branded = false } = {}) {
    const data = await fdcRequest(apiKey, '/foods/search', {
        query,
        dataType: branded ? [...GENERIC_TYPES, 'Branded'] : GENERIC_TYPES,
        pageSize: 25,
    });
    return (data.foods || [])
        .map(f => ({
            fdcId: f.fdcId,
            name: f.description,
            type: f.dataType,
            brand: f.brandName || f.brandOwner || '',
            kcalPer100g: kcalPer100g(f.foodNutrients),
        }))
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
function gramsPerUnit(food) {
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

// { fdcId, name, kcalPer100g, gramsPerUnit }
export async function getFood(apiKey, fdcId) {
    const food = await fdcRequest(apiKey, `/food/${encodeURIComponent(fdcId)}`);
    const kcal = kcalPer100g(food.foodNutrients);
    if (kcal == null) throw new NutritionError(`USDA has no calorie figure for "${food.description}"`, 404);
    return {
        fdcId: food.fdcId,
        name: food.description,
        kcalPer100g: round1(kcal),
        gramsPerUnit: gramsPerUnit(food),
    };
}
