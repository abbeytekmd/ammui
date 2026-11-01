// Sky tab: a chart of the sky from a saved location, worked out here in the browser
// (bright stars, constellation figures, the planets, Moon and Sun), and a list of what's worth
// looking at tonight: planets, close pairings, meteor showers, Algol dimming, eclipses and aurora.
// Positions are low precision (a fraction of a degree), which is plenty for naked-eye viewing.

const SKY_DEG = Math.PI / 180;
const skySin = d => Math.sin(d * SKY_DEG);
const skyCos = d => Math.cos(d * SKY_DEG);
const skyNorm = d => ((d % 360) + 360) % 360;
const skyJd = t => t / 86400000 + 2440587.5; // ms since 1970 -> Julian day
const SKY_HOUR = 3600000;
const SKY_DAY = 86400000;
const SKY_OBLIQUITY = 23.4393;

// Bright stars: [name, RA hours, Dec degrees, magnitude, colour (optional)], J2000
const SKY_STARS = [
    ['Sirius', 6.7525, -16.716, -1.46], ['Canopus', 6.3992, -52.696, -0.74], ['Rigil Kentaurus', 14.66, -60.834, -0.27],
    ['Arcturus', 14.261, 19.182, -0.05, '#ffd2a1'], ['Vega', 18.6156, 38.784, 0.03], ['Capella', 5.2782, 45.998, 0.08, '#fff4d6'],
    ['Rigel', 5.2423, -8.202, 0.13, '#cfe0ff'], ['Procyon', 7.655, 5.225, 0.34], ['Achernar', 1.6286, -57.237, 0.46],
    ['Betelgeuse', 5.9195, 7.407, 0.5, '#ffb07a'], ['Hadar', 14.0637, -60.373, 0.61], ['Altair', 19.8464, 8.868, 0.77],
    ['Acrux', 12.4433, -63.099, 0.76], ['Aldebaran', 4.5987, 16.509, 0.86, '#ffbf8a'], ['Antares', 16.4901, -26.432, 1.06, '#ff9f73'],
    ['Spica', 13.4199, -11.161, 0.97, '#cfe0ff'], ['Pollux', 7.7553, 28.026, 1.14, '#ffe0b0'], ['Fomalhaut', 22.9608, -29.622, 1.16],
    ['Deneb', 20.6905, 45.28, 1.25], ['Mimosa', 12.7954, -59.689, 1.25], ['Regulus', 10.1395, 11.967, 1.36, '#d8e4ff'],
    ['Adhara', 6.9771, -28.972, 1.5], ['Castor', 7.5767, 31.888, 1.58], ['Gacrux', 12.5194, -57.113, 1.63, '#ffb07a'],
    ['Shaula', 17.5601, -37.104, 1.62], ['Bellatrix', 5.4189, 6.35, 1.64], ['Elnath', 5.4382, 28.608, 1.65],
    ['Miaplacidus', 9.22, -69.717, 1.68], ['Alnilam', 5.6036, -1.202, 1.69], ['Alnair', 22.1372, -46.961, 1.74],
    ['Alnitak', 5.6793, -1.943, 1.77], ['Alioth', 12.9005, 55.96, 1.77], ['Dubhe', 11.0621, 61.751, 1.79, '#ffd9a8'],
    ['Mirfak', 3.4054, 49.861, 1.79], ['Wezen', 7.1399, -26.393, 1.83], ['Regor', 8.1589, -47.337, 1.83],
    ['Kaus Australis', 18.4029, -34.385, 1.85], ['Avior', 8.3752, -59.51, 1.86], ['Alkaid', 13.7923, 49.313, 1.86],
    ['Sargas', 17.622, -42.998, 1.86], ['Menkalinan', 5.9921, 44.948, 1.9], ['Atria', 16.8111, -69.028, 1.91, '#ffc58f'],
    ['Alhena', 6.6285, 16.399, 1.93], ['Peacock', 20.4275, -56.735, 1.94], ['Polaris', 2.5303, 89.264, 1.98],
    ['Mirzam', 6.3783, -17.956, 1.98], ['Alphard', 9.4598, -8.659, 1.98, '#ffc58f'], ['Hamal', 2.1196, 23.463, 2.0, '#ffd2a1'],
    ['Algieba', 10.3329, 19.842, 2.01], ['Diphda', 0.7265, -17.987, 2.04], ['Nunki', 18.9211, -26.297, 2.05],
    ['Mirach', 1.1622, 35.621, 2.05, '#ffc58f'], ['Alpheratz', 0.1398, 29.091, 2.06], ['Rasalhague', 17.5823, 12.56, 2.07],
    ['Kochab', 14.8451, 74.156, 2.08, '#ffc58f'], ['Saiph', 5.7959, -9.67, 2.09], ['Almach', 2.065, 42.33, 2.1, '#ffd2a1'],
    ['Algol', 3.1361, 40.956, 2.12], ['Denebola', 11.8177, 14.572, 2.14], ['Alphecca', 15.5781, 26.715, 2.23],
    ['Mintaka', 5.5334, -0.299, 2.23], ['Sadr', 20.3705, 40.257, 2.23], ['Eltanin', 17.9434, 51.489, 2.23, '#ffc58f'],
    ['Schedar', 0.6751, 56.537, 2.24, '#ffd2a1'], ['Caph', 0.153, 59.15, 2.27], ['Mizar', 13.3988, 54.925, 2.27],
    ['Dschubba', 16.0056, -22.622, 2.29], ['ε Sco', 16.8361, -34.293, 2.29], ['Izar', 14.7498, 27.074, 2.37],
    ['Merak', 11.0307, 56.383, 2.37], ['Enif', 21.7364, 9.875, 2.39, '#ffc58f'], ['κ Sco', 17.7081, -39.03, 2.39],
    ['Scheat', 23.0629, 28.083, 2.42, '#ffb07a'], ['Phecda', 11.8972, 53.695, 2.44], ['Aludra', 7.4016, -29.303, 2.45],
    ['Alderamin', 21.3097, 62.586, 2.45], ['Navi', 0.9451, 60.717, 2.47], ['Markab', 23.0794, 15.205, 2.48],
    ['Gienah', 20.7702, 33.97, 2.48], ['Menkar', 3.038, 4.09, 2.54, '#ffb07a'], ['Zosma', 11.2351, 20.524, 2.56],
    ['Ascella', 19.0435, -29.88, 2.6], ['Gienah Corvi', 12.2634, -17.542, 2.59], ['Acrab', 16.0906, -19.806, 2.62],
    ['θ Aur', 5.9954, 37.213, 2.62], ['Sheratan', 1.9107, 20.808, 2.64], ['Kraz', 12.5731, -23.397, 2.65],
    ['Muphrid', 13.9114, 18.398, 2.68], ['Ruchbah', 1.4303, 60.235, 2.68], ['Hassaleh', 4.95, 33.166, 2.69, '#ffc58f'],
    ['Kaus Media', 18.3499, -29.828, 2.7], ['Tarazed', 19.771, 10.613, 2.72, '#ffc58f'], ['Rastaban', 17.5072, 52.301, 2.79],
    ['Kaus Borealis', 18.4662, -25.422, 2.81], ['ζ Her', 16.6881, 31.603, 2.81], ['τ Sco', 16.598, -28.216, 2.82],
    ['ζ Per', 3.9022, 31.884, 2.85], ['Alcyone', 3.7914, 24.105, 2.87], ['Tejat', 6.3827, 22.514, 2.87, '#ffb07a'],
    ['δ Cyg', 19.7496, 45.131, 2.87], ['ε Per', 3.9642, 40.01, 2.89], ['Gomeisa', 7.4525, 8.289, 2.89],
    ['π Sco', 15.9809, -26.114, 2.89], ['σ Sco', 16.3531, -25.593, 2.9], ['γ Per', 3.0799, 53.506, 2.93],
    ['Matar', 22.7167, 30.221, 2.94], ['Algorab', 12.4977, -16.515, 2.95], ['Mebsuta', 6.7322, 25.131, 2.98],
    ['ε Leo', 9.7642, 23.774, 2.98], ['Alnasl', 18.0968, -30.424, 2.98], ['ζ Aql', 19.0902, 13.863, 2.99],
    ['ε Aur', 5.0328, 43.823, 2.99], ['ζ Tau', 5.6274, 21.143, 3.0], ['Minkar', 12.1688, -22.62, 3.0],
    ['μ Sco', 16.8645, -38.048, 3.0], ['ι Sco', 17.7931, -40.127, 3.0], ['δ Per', 3.7154, 47.788, 3.01],
    ['Seginus', 14.5346, 38.308, 3.03], ['Albireo', 19.512, 27.96, 3.05, '#ffd2a1'], ['Pherkad', 15.3455, 71.834, 3.05],
    ['π Her', 17.2508, 36.809, 3.16, '#ffc58f'], ['φ Sgr', 18.761, -26.991, 3.17], ['ζ Cyg', 21.2156, 30.227, 3.2],
    ['Errai', 23.6558, 77.632, 3.21], ['Alfirk', 21.4777, 70.561, 3.23], ['θ Aql', 20.1884, -0.821, 3.23],
    ['Sulafat', 18.9824, 32.69, 3.25], ['δ And', 0.6555, 30.861, 3.27], ['τ Sgr', 19.1157, -27.67, 3.32],
    ['Chertan', 11.2373, 15.43, 3.33], ['η Sco', 17.2026, -43.239, 3.33], ['ζ Cep', 22.1809, 58.201, 3.35],
    ['δ Aql', 19.425, 3.115, 3.36], ['Segin', 1.9066, 63.67, 3.37], ['Meissa', 5.5856, 9.934, 3.39],
    ['Homam', 22.691, 10.831, 3.4], ['λ Aql', 19.1041, -4.883, 3.43], ['Adhafera', 10.2782, 23.417, 3.44],
    ['δ Boo', 15.2584, 33.315, 3.47], ['η Her', 16.7149, 38.922, 3.48], ['η Leo', 10.1222, 16.763, 3.49],
    ['Nekkar', 15.0324, 40.391, 3.5], ['ι Cep', 22.828, 66.201, 3.5], ['Sheliak', 18.8347, 33.363, 3.52],
    ['ε Tau', 4.4769, 19.181, 3.53], ['Biham', 22.17, 6.198, 3.53], ['Wasat', 7.3354, 21.982, 3.53],
    ['Thuban', 14.0731, 64.376, 3.65], ['γ Tau', 4.3299, 15.628, 3.65], ['Alshain', 19.9219, 6.407, 3.71],
    ['Grumium', 17.8921, 56.873, 3.75], ['μ Leo', 9.8794, 26.007, 3.88], ['Mesarthim', 1.8922, 19.294, 3.9],
    ['ε Her', 17.0048, 30.926, 3.92], ['ε UMi', 16.7661, 82.037, 4.21], ['δ Lyr', 18.9084, 36.899, 4.3],
    ['ζ UMi', 15.7343, 77.794, 4.32], ['Yildun', 17.5369, 86.586, 4.35], ['ζ Lyr', 18.7461, 37.605, 4.36],
    ['η UMi', 16.2918, 75.755, 4.95], ['Megrez', 12.2571, 57.033, 3.31], ['Algenib', 0.2206, 15.184, 2.83],
    ['Imai', 12.2524, -58.749, 2.8],
];
const SKY_STAR_BY_NAME = Object.fromEntries(SKY_STARS.map(s => [s[0], s]));

// Constellation stick figures, as chains of star names
const SKY_FIGURES = {
    'Ursa Major': [['Dubhe', 'Merak', 'Phecda', 'Megrez', 'Dubhe'], ['Megrez', 'Alioth', 'Mizar', 'Alkaid']],
    'Ursa Minor': [['Polaris', 'Yildun', 'ε UMi', 'ζ UMi', 'Kochab', 'Pherkad', 'η UMi', 'ζ UMi']],
    'Cassiopeia': [['Caph', 'Schedar', 'Navi', 'Ruchbah', 'Segin']],
    'Orion': [['Betelgeuse', 'Alnitak', 'Saiph'], ['Bellatrix', 'Mintaka', 'Rigel'], ['Alnitak', 'Alnilam', 'Mintaka'],
        ['Betelgeuse', 'Meissa', 'Bellatrix']],
    'Canis Major': [['Sirius', 'Mirzam'], ['Sirius', 'Wezen', 'Adhara'], ['Wezen', 'Aludra']],
    'Canis Minor': [['Procyon', 'Gomeisa']],
    'Gemini': [['Castor', 'Mebsuta', 'Tejat'], ['Pollux', 'Wasat', 'Alhena'], ['Castor', 'Pollux']],
    'Taurus': [['Aldebaran', 'ε Tau', 'Elnath'], ['Aldebaran', 'γ Tau'], ['ε Tau', 'ζ Tau']],
    'Auriga': [['Capella', 'Menkalinan', 'θ Aur', 'Elnath', 'Hassaleh', 'ε Aur', 'Capella']],
    'Perseus': [['Mirfak', 'γ Per'], ['Mirfak', 'δ Per', 'ε Per', 'ζ Per'], ['Mirfak', 'Algol']],
    'Leo': [['Regulus', 'η Leo', 'Algieba', 'Adhafera', 'μ Leo', 'ε Leo'], ['Algieba', 'Zosma', 'Denebola', 'Chertan', 'Regulus'],
        ['Zosma', 'Chertan']],
    'Boötes': [['Arcturus', 'Izar', 'δ Boo', 'Nekkar', 'Seginus', 'Arcturus'], ['Arcturus', 'Muphrid']],
    'Corvus': [['Gienah Corvi', 'Algorab', 'Kraz', 'Minkar', 'Gienah Corvi']],
    'Scorpius': [['Acrab', 'Dschubba', 'π Sco'], ['Dschubba', 'σ Sco', 'Antares', 'τ Sco', 'ε Sco', 'μ Sco', 'η Sco', 'Sargas', 'ι Sco', 'κ Sco', 'Shaula']],
    'Sagittarius': [['Alnasl', 'Kaus Media', 'Kaus Australis', 'Ascella', 'φ Sgr', 'Kaus Media', 'Kaus Borealis', 'φ Sgr', 'Nunki', 'τ Sgr', 'Ascella'],
        ['Alnasl', 'Kaus Australis']],
    'Lyra': [['Vega', 'ζ Lyr', 'Sheliak', 'Sulafat', 'δ Lyr', 'ζ Lyr']],
    'Cygnus': [['Deneb', 'Sadr', 'Albireo'], ['δ Cyg', 'Sadr', 'Gienah', 'ζ Cyg']],
    'Aquila': [['Tarazed', 'Altair', 'Alshain'], ['Altair', 'δ Aql', 'λ Aql'], ['δ Aql', 'ζ Aql'], ['Alshain', 'θ Aql']],
    'Hercules': [['ζ Her', 'η Her', 'π Her', 'ε Her', 'ζ Her']],
    'Draco': [['Rastaban', 'Eltanin', 'Grumium', 'Rastaban'], ['Thuban', 'Kochab']],
    'Cepheus': [['Alderamin', 'Alfirk', 'Errai', 'ι Cep', 'ζ Cep', 'Alderamin']],
    'Pegasus': [['Markab', 'Scheat', 'Alpheratz', 'Algenib', 'Markab'], ['Markab', 'Homam', 'Biham', 'Enif'], ['Scheat', 'Matar']],
    'Andromeda': [['Alpheratz', 'δ And', 'Mirach', 'Almach']],
    'Aries': [['Hamal', 'Sheratan', 'Mesarthim']],
    'Crux': [['Acrux', 'Gacrux'], ['Mimosa', 'Imai']],
};

// Galaxies, clusters and nebulae that show to the eye or binoculars: [name, RA, Dec, magnitude, what it is]
const SKY_DEEP = [
    ['Andromeda Galaxy', 0.712, 41.27, 3.4, 'the most distant thing you can see with your eyes, 2.5 million light years'],
    ['Pleiades', 3.79, 24.12, 1.6, 'the Seven Sisters star cluster'],
    ['Orion Nebula', 5.588, -5.39, 4.0, 'a star nursery in Orion\'s sword'],
    ['Double Cluster', 2.33, 57.13, 3.7, 'twin star clusters between Perseus and Cassiopeia'],
    ['Beehive Cluster', 8.67, 19.67, 3.7, 'a hazy star cluster in Cancer'],
    ['Hercules Cluster', 16.695, 36.46, 5.8, 'a globular cluster of hundreds of thousands of stars'],
];

// Planets: Keplerian elements and rates per century (JPL, 1800–2050): a, e, I, L, long. perihelion, long. node
const SKY_PLANETS = [
    { name: 'Mercury', colour: '#c9b9a6', mag: [-0.42, 0.038, -0.000273, 0.000002],
      el: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
      rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081] },
    { name: 'Venus', colour: '#fff3c4', mag: [-4.4, 0.0009, 0.000239, -0.00000065],
      el: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255],
      rate: [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418] },
    { name: 'Earth', el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0],
      rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0] },
    { name: 'Mars', colour: '#ff8a5c', mag: [-1.52, 0.016, 0, 0],
      el: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
      rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343] },
    { name: 'Jupiter', colour: '#f5dcb4', mag: [-9.4, 0.005, 0, 0],
      el: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
      rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106] },
    { name: 'Saturn', colour: '#e8d08f', mag: [-8.88, 0.044, 0, 0],
      el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
      rate: [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794] },
    { name: 'Uranus', colour: '#a8e6e8', mag: [-7.19, 0, 0, 0],
      el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503],
      rate: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589] },
    { name: 'Neptune', colour: '#8fb4ff', mag: [-6.87, 0, 0, 0],
      el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
      rate: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664] },
];

// Annual meteor showers (IMO): active from/to and peak as [month, day], ZHR at peak, radiant RA/Dec
const SKY_SHOWERS = [
    { name: 'Quadrantids', from: [12, 28], peak: [1, 4], to: [1, 12], zhr: 110, ra: 15.33, dec: 49.5 },
    { name: 'Lyrids', from: [4, 14], peak: [4, 22], to: [4, 30], zhr: 18, ra: 18.07, dec: 34 },
    { name: 'Eta Aquariids', from: [4, 19], peak: [5, 6], to: [5, 28], zhr: 50, ra: 22.53, dec: -1 },
    { name: 'Southern Delta Aquariids', from: [7, 12], peak: [7, 30], to: [8, 23], zhr: 25, ra: 22.67, dec: -16 },
    { name: 'Alpha Capricornids', from: [7, 3], peak: [7, 30], to: [8, 15], zhr: 5, ra: 20.47, dec: -10 },
    { name: 'Perseids', from: [7, 17], peak: [8, 12], to: [8, 24], zhr: 100, ra: 3.2, dec: 58 },
    { name: 'Draconids', from: [10, 6], peak: [10, 8], to: [10, 10], zhr: 10, ra: 17.47, dec: 54 },
    { name: 'Southern Taurids', note: 'slow, with the odd bright fireball', from: [9, 10], peak: [10, 10], to: [11, 20], zhr: 5, ra: 2.13, dec: 9 },
    { name: 'Orionids', from: [10, 2], peak: [10, 21], to: [11, 7], zhr: 20, ra: 6.33, dec: 16 },
    { name: 'Northern Taurids', note: 'slow, with the odd bright fireball', from: [10, 20], peak: [11, 12], to: [12, 10], zhr: 5, ra: 3.87, dec: 22 },
    { name: 'Leonids', from: [11, 6], peak: [11, 17], to: [11, 30], zhr: 15, ra: 10.27, dec: 22 },
    { name: 'Geminids', from: [12, 4], peak: [12, 14], to: [12, 20], zhr: 150, ra: 7.47, dec: 33 },
    { name: 'Ursids', from: [12, 17], peak: [12, 22], to: [12, 26], zhr: 10, ra: 14.47, dec: 75 },
];

// Algol, the "demon star", dims from magnitude 2.1 to 3.4 for a few hours every 2.87 days
const ALGOL_EPOCH = 2445641.5135; // a time of minimum (Julian day)
const ALGOL_PERIOD = 2.867328;

// --- Positions ---

// Heliocentric ecliptic x, y, z (AU) of a planet
function skyHelio(p, T) {
    const [a, e, I, L, wbar, node] = p.el.map((v, i) => v + p.rate[i] * T);
    const w = wbar - node;
    const M = skyNorm(L - wbar) * SKY_DEG;
    let E = M + e * Math.sin(M);
    for (let i = 0; i < 6; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const cw = skyCos(w), sw = skySin(w), cO = skyCos(node), sO = skySin(node), cI = skyCos(I), sI = skySin(I);
    return [
        (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
        (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
        sw * sI * xp + cw * sI * yp,
    ];
}

// Ecliptic longitude/latitude (degrees) to RA (hours) / Dec (degrees)
function skyEclToEq(lon, lat) {
    const x = skyCos(lat) * skyCos(lon);
    const y = skyCos(lat) * skySin(lon) * skyCos(SKY_OBLIQUITY) - skySin(lat) * skySin(SKY_OBLIQUITY);
    const z = skyCos(lat) * skySin(lon) * skySin(SKY_OBLIQUITY) + skySin(lat) * skyCos(SKY_OBLIQUITY);
    return { ra: skyNorm(Math.atan2(y, x) / SKY_DEG) / 15, dec: Math.asin(z) / SKY_DEG };
}

// The Moon, geocentric (Astronomical Almanac low-precision series, about 0.3°)
function skyMoon(T) {
    const lon = 218.32 + 481267.881 * T + 6.29 * skySin(135.0 + 477198.87 * T) - 1.27 * skySin(259.3 - 413335.36 * T)
        + 0.66 * skySin(235.7 + 890534.22 * T) + 0.21 * skySin(269.9 + 954397.74 * T)
        - 0.19 * skySin(357.5 + 35999.05 * T) - 0.11 * skySin(186.5 + 966404.03 * T);
    const lat = 5.13 * skySin(93.3 + 483202.02 * T) + 0.28 * skySin(228.2 + 960400.89 * T)
        - 0.28 * skySin(318.3 + 6003.15 * T) - 0.17 * skySin(217.6 - 407332.21 * T);
    const parallax = 0.9508 + 0.0518 * skyCos(135.0 + 477198.87 * T) + 0.0095 * skyCos(259.3 - 413335.36 * T)
        + 0.0078 * skyCos(235.7 + 890534.22 * T) + 0.0028 * skyCos(269.9 + 954397.74 * T);
    return { lon: skyNorm(lon), lat, parallax, km: 6378.14 / skySin(parallax) };
}

// Altitude and azimuth (degrees, azimuth from north through east) of RA/Dec at a sidereal time
function skyAltAz(ra, dec, lst, lat) {
    const H = lst - ra * 15;
    const sinAlt = skySin(lat) * skySin(dec) + skyCos(lat) * skyCos(dec) * skyCos(H);
    const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) / SKY_DEG;
    const az = skyNorm(Math.atan2(-skyCos(dec) * skySin(H), skySin(dec) * skyCos(lat) - skyCos(dec) * skySin(lat) * skyCos(H)) / SKY_DEG);
    return { alt, az };
}

const skyLst = (jd, lon) => skyNorm(280.46061837 + 360.98564736629 * (jd - 2451545) + lon);

// Angle between two RA/Dec positions, degrees
function skySeparation(a, b) {
    const c = skySin(a.dec) * skySin(b.dec) + skyCos(a.dec) * skyCos(b.dec) * skyCos((a.ra - b.ra) * 15);
    return Math.acos(Math.max(-1, Math.min(1, c))) / SKY_DEG;
}

// Everything that moves, at a moment, seen from loc
function skyBodies(t, loc) {
    const jd = skyJd(t);
    const T = (jd - 2451545) / 36525;
    const lst = skyLst(jd, loc.lon);
    const earth = skyHelio(SKY_PLANETS[2], T);
    const R = Math.hypot(...earth);
    const sunLon = skyNorm(Math.atan2(-earth[1], -earth[0]) / SKY_DEG);
    const sun = { name: 'Sun', lon: sunLon, ...skyEclToEq(sunLon, 0) };
    Object.assign(sun, skyAltAz(sun.ra, sun.dec, lst, loc.lat));

    const planets = SKY_PLANETS.filter(p => p.mag).map(p => {
        const h = skyHelio(p, T);
        const g = [h[0] - earth[0], h[1] - earth[1], h[2] - earth[2]];
        const r = Math.hypot(...h), delta = Math.hypot(...g);
        const lon = skyNorm(Math.atan2(g[1], g[0]) / SKY_DEG);
        const lat = Math.asin(g[2] / delta) / SKY_DEG;
        const i = Math.acos(Math.max(-1, Math.min(1, (r * r + delta * delta - R * R) / (2 * r * delta)))) / SKY_DEG;
        const [m0, m1, m2, m3] = p.mag;
        const body = { name: p.name, colour: p.colour, lon, lat, delta, ...skyEclToEq(lon, lat) };
        body.mag = m0 + 5 * Math.log10(r * delta) + m1 * i + m2 * i * i + m3 * i * i * i;
        body.elongation = skySeparation(body, sun);
        return Object.assign(body, skyAltAz(body.ra, body.dec, lst, loc.lat));
    });

    const m = skyMoon(T);
    const moon = { name: 'Moon', ...m, ...skyEclToEq(m.lon, m.lat) };
    Object.assign(moon, skyAltAz(moon.ra, moon.dec, lst, loc.lat));
    moon.alt -= m.parallax * skyCos(moon.alt); // seen from the ground, not Earth's centre
    moon.elongation = skySeparation(moon, sun);
    moon.illumination = (1 - skyCos(moon.elongation)) / 2;
    moon.age = skyNorm(m.lon - sunLon); // 0 new, 90 first quarter, 180 full, 270 last quarter
    return { t, lst, sun, moon, planets };
}

// --- Events ---

const skySunAlt = (t, loc) => skyBodies(t, loc).sun.alt;

// Times when f(t) crosses level between from and to, sampled every step ms: [{ t, rising }]
function skyCrossings(f, level, from, to, step) {
    const out = [];
    let prevT = from, prev = f(from) - level;
    for (let t = from + step; t <= to; t += step) {
        const v = f(t) - level;
        if ((prev < 0) !== (v < 0)) out.push({ t: prevT + step * prev / (prev - v), rising: v > 0 });
        prevT = t; prev = v;
    }
    return out;
}

// The night that's on now, or the coming one: from the noon before it to the noon after
function skyNightWindow(now) {
    const d = new Date(now);
    const noon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getHours() < 12 ? 1 : 0), 12);
    return [noon.getTime(), new Date(noon.getFullYear(), noon.getMonth(), noon.getDate() + 1, 12).getTime()];
}

function skyNight(now, loc) {
    const [from, to] = skyNightWindow(now);
    const step = 5 * 60000;
    const sunAlts = [];
    for (let t = from; t <= to; t += step) sunAlts.push(skySunAlt(t, loc));
    const f = t => sunAlts[Math.round((t - from) / step)];
    const at = (level, rising) => skyCrossings(f, level, from, to, step).find(c => c.rising === rising)?.t ?? null;
    const night = {
        from, to,
        sunset: at(-0.833, false), sunrise: at(-0.833, true),
        darkFrom: at(-18, false), darkTo: at(-18, true),
        nauticalFrom: at(-12, false), nauticalTo: at(-12, true),
    };
    // Midsummer far north: never fully dark, so use the darkest part there is
    night.viewFrom = night.darkFrom ?? night.nauticalFrom ?? at(-6, false) ?? night.sunset ?? from;
    night.viewTo = night.darkTo ?? night.nauticalTo ?? at(-6, true) ?? night.sunrise ?? to;
    night.neverDark = !night.darkFrom && !night.darkTo && Math.min(...sunAlts) > -18;
    night.noNight = Math.min(...sunAlts) > -0.833;
    return night;
}

// Hourly samples through the darker part of the night
function skyNightSamples(night, loc) {
    const out = [];
    if (night.noNight) return out;
    const from = Math.max(night.sunset ?? night.from, night.from), to = night.sunrise ?? night.to;
    for (let t = from + 30 * 60000; t < to; t += 30 * 60000) {
        const b = skyBodies(t, loc);
        if (b.sun.alt < -8) out.push(b);
    }
    return out;
}

// When the Moon is next new, or full, from t: the moment its age passes target
function skyNextPhase(t, target) {
    const age = t => skyNorm(skyMoon((skyJd(t) - 2451545) / 36525).lon - skyBodies(t, { lat: 0, lon: 0 }).sun.lon - target + 180) - 180;
    let a = t, va = age(a);
    for (let b = t + 6 * SKY_HOUR; b < t + 32 * SKY_DAY; b += 6 * SKY_HOUR) {
        const vb = age(b);
        if (va < 0 && vb >= 0 && vb - va < 90) {
            for (let i = 0; i < 20; i++) {
                const mid = (a + b) / 2, vm = age(mid);
                if (vm < 0) a = mid; else b = mid;
            }
            return (a + b) / 2;
        }
        a = b; va = vb;
    }
    return null;
}

// Moonrise and moonset in the next day
function skyMoonRiseSet(now, loc) {
    const f = t => skyBodies(t, loc).moon.alt;
    const c = skyCrossings(f, -0.833, now, now + SKY_DAY, 10 * 60000);
    return { rise: c.find(x => x.rising)?.t ?? null, set: c.find(x => !x.rising)?.t ?? null };
}

// Eclipses in the coming two years that can be seen from here
function skyEclipses(now, loc) {
    const out = [];
    let t = now;
    for (let n = 0; n < 25 && out.length < 3; n++) {
        const full = skyNextPhase(t, 180);
        const newMoon = skyNextPhase(t, 0);
        if (full) {
            const b = skyBodies(full, loc);
            const umbra = 1.02 * (0.99833 * b.moon.parallax - 0.2666 + 0.0024);
            const moonR = 0.2725 * b.moon.parallax;
            const gap = Math.abs(b.moon.lat);
            const kind = gap < umbra - moonR ? 'Total' : gap < umbra + moonR ? 'Partial' : null;
            if (kind) {
                // Up for any of the two hours either side of the middle?
                let seen = false;
                for (let dt = -2 * SKY_HOUR; dt <= 2 * SKY_HOUR; dt += 30 * 60000) if (skyBodies(full + dt, loc).moon.alt > 0) seen = true;
                if (seen) out.push({ t: full, text: `${kind} lunar eclipse`, detail: kind === 'Total' ? 'the Moon turns coppery red' : 'part of the Moon darkens' });
            }
        }
        if (newMoon) {
            // From here the Moon sits a little lower than from Earth's centre: find how close it gets to the Sun
            let best = null;
            for (let dt = -5 * SKY_HOUR; dt <= 5 * SKY_HOUR; dt += 10 * 60000) {
                const b = skyBodies(newMoon + dt, loc);
                if (b.sun.alt < 0) continue;
                const topo = skyTopocentricMoon(b, loc);
                const sep = skySeparation(topo, b.sun);
                if (!best || sep < best.sep) best = { sep, t: newMoon + dt, moonR: 0.2725 * b.moon.parallax };
            }
            const sunR = 0.2666;
            if (best && best.sep < sunR + best.moonR - 0.02) {
                const covered = Math.min(1, (sunR + best.moonR - best.sep) / (2 * sunR));
                out.push({ t: best.t, text: 'Solar eclipse', detail: `about ${Math.round(covered * 100)}% of the Sun's width covered from here — never look without eclipse glasses` });
            }
        }
        t = Math.max(full || t, newMoon || t) + SKY_DAY;
    }
    return out.sort((a, b) => a.t - b.t);
}

// The Moon's RA/Dec shifted for being on Earth's surface rather than at its centre
function skyTopocentricMoon(b, loc) {
    const H = (b.lst - b.moon.ra * 15) * SKY_DEG;
    const p = skySin(b.moon.parallax), phi = loc.lat * SKY_DEG, dec = b.moon.dec * SKY_DEG;
    const dRa = Math.atan2(-Math.cos(phi) * p * Math.sin(H), Math.cos(dec) - Math.cos(phi) * p * Math.cos(H));
    const decT = Math.atan2((Math.sin(dec) - Math.sin(phi) * p) * Math.cos(dRa), Math.cos(dec) - Math.cos(phi) * p * Math.cos(H));
    return { ra: b.moon.ra + dRa / SKY_DEG / 15, dec: decT / SKY_DEG };
}

// Full moon names; the Harvest Moon is the one nearest the September equinox, the Hunter's Moon the next
const SKY_MOON_NAMES = ['Wolf', 'Snow', 'Worm', 'Pink', 'Flower', 'Strawberry', 'Buck', 'Sturgeon', 'Corn', "Hunter's", 'Beaver', 'Cold'];
function skyFullMoonName(t) {
    const d = new Date(t);
    const equinox = new Date(d.getFullYear(), 8, 22).getTime();
    const daysAfter = (t - equinox) / SKY_DAY;
    if (Math.abs(daysAfter) <= 14.8) return 'Harvest Moon';
    if (daysAfter > 14.8 && daysAfter <= 44.3) return "Hunter's Moon";
    const name = SKY_MOON_NAMES[d.getMonth()];
    return `${name === "Hunter's" ? 'Blood' : name} Moon`;
}

function skyPhaseName(age) {
    if (age < 6 || age > 354) return 'New Moon';
    if (age < 84) return 'Waxing Crescent';
    if (age < 96) return 'First Quarter';
    if (age < 174) return 'Waxing Gibbous';
    if (age < 186) return 'Full Moon';
    if (age < 264) return 'Waning Gibbous';
    if (age < 276) return 'Last Quarter';
    return 'Waning Crescent';
}

// The shower's dates this season, around t
function skyShowerDates(s, t) {
    const year = new Date(t).getFullYear();
    for (const y of [year - 1, year, year + 1]) {
        const from = new Date(y, s.from[0] - 1, s.from[1]).getTime();
        const toYear = s.to[0] < s.from[0] ? y + 1 : y;
        const peakYear = s.peak[0] < s.from[0] ? y + 1 : y;
        const to = new Date(toYear, s.to[0] - 1, s.to[1], 23, 59).getTime();
        if (t <= to) return { from, to, peak: new Date(peakYear, s.peak[0] - 1, s.peak[1]).getTime() };
    }
}

const SKY_COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const skyCompass = az => SKY_COMPASS[Math.round(skyNorm(az) / 22.5) % 16];
const skyClock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const skyDay = t => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const skyAttr = s => escapeHtml(s).replace(/"/g, '&quot;');
const skyMag = m => (m < 0 ? '−' : '') + Math.abs(m).toFixed(1);
// "low in the SE", "high in the S", "overhead"
function skyWhere(alt, az) {
    if (alt > 75) return 'overhead';
    const height = alt < 15 ? 'low' : alt < 45 ? 'part way up' : 'high';
    return `${height} in the ${skyCompass(az)}`;
}

// The Kp that usually brings the aurora into view (on camera, low in the sky) at a latitude
const skyAuroraKp = lat => Math.max(1, Math.round((67 - Math.abs(lat)) / 2.5));

// What's worth a look tonight: [{ kind, icon, title, detail }]
function skyHighlights(now, loc, night, samples, kp) {
    const out = [];
    const darkSamples = samples.filter(b => b.sun.alt < -12);
    const best = darkSamples.length ? darkSamples : samples;

    // Planets: when each is highest while it's dark enough to see
    for (const p of SKY_PLANETS.filter(p => p.mag)) {
        let top = null;
        for (const b of samples) {
            const body = b.planets.find(x => x.name === p.name);
            const limit = body.mag < -1 ? -6 : -10; // the brightest show in twilight
            if (b.sun.alt < limit && body.alt > 5 && (!top || body.alt > top.body.alt)) top = { t: b.t, body };
        }
        if (!top) continue;
        const { body } = top;
        if (body.mag > 5.5) { // Uranus and Neptune need binoculars or a telescope
            if (body.alt > 25) out.push({ kind: 'faint', icon: '🔭', title: `${p.name} (binoculars)`, detail: `magnitude ${skyMag(body.mag)}, ${skyWhere(body.alt, body.az)} around ${skyClock(top.t)}` });
            continue;
        }
        out.push({ kind: 'planet', icon: '🪐', name: p.name, colour: p.colour, title: p.name,
            detail: `magnitude ${skyMag(body.mag)}, ${skyWhere(body.alt, body.az)} around ${skyClock(top.t)}`, mag: body.mag });
    }

    // Planet events within a few weeks: opposition, greatest elongation, retrograde
    const daysAround = [];
    for (let d = -20; d <= 20; d++) daysAround.push(skyBodies(now + d * SKY_DAY, loc));
    for (const p of SKY_PLANETS.filter(p => p.mag)) {
        const series = daysAround.map(b => b.planets.find(x => x.name === p.name));
        const elong = series.map(x => x.elongation);
        const peak = elong.indexOf(Math.max(...elong));
        const inner = p.name === 'Mercury' || p.name === 'Venus';
        const at = now + (peak - 20) * SKY_DAY;
        if (!inner && elong[peak] > 175 && peak > 0 && peak < 40) {
            out.push({ kind: 'event', icon: '⭐', title: `${p.name} at opposition ${peak === 20 ? 'now' : skyDay(at)}`,
                detail: 'Opposite the Sun: up all night and at its closest and brightest' });
        } else if (inner && peak > 0 && peak < 40 && Math.abs(peak - 20) <= 14) {
            const evening = skyNorm(series[peak].lon - daysAround[peak].sun.lon) < 180;
            out.push({ kind: 'event', icon: '📐', title: `${p.name} furthest from the Sun ${skyDay(at)}`,
                detail: `${Math.round(elong[peak])}° from the Sun in the ${evening ? 'evening sky after sunset' : 'morning sky before sunrise'}: the best time to spot it` });
        }
        // Drifting backwards (westwards) against the stars: told with the planet, if it's on show
        const move = skyNorm(series[21].lon - series[20].lon + 180) - 180;
        const shown = out.find(h => h.kind === 'planet' && h.name === p.name);
        if (move < 0 && shown) shown.detail += '; in retrograde, drifting backwards against the stars for now';
    }

    // Close pairings of the Moon, planets and bright stars
    const pairs = new Map();
    for (const b of best) {
        const things = [
            ...(b.moon.alt > 3 ? [{ ...b.moon, kind: 'moon' }] : []),
            ...b.planets.filter(p => p.alt > 3 && p.mag < 6).map(p => ({ ...p, kind: 'planet' })),
            ...SKY_STARS.filter(s => s[3] < 1.5).map(s => ({ name: s[0], ra: s[1], dec: s[2], kind: 'star' })),
            { name: 'the Pleiades', ra: 3.79, dec: 24.12, kind: 'star' },
        ];
        for (let i = 0; i < things.length; i++) for (let j = i + 1; j < things.length; j++) {
            const a = things[i], c = things[j];
            if (a.kind === 'star' && c.kind === 'star') continue;
            const limit = a.kind === 'moon' || c.kind === 'moon' ? 5 : a.kind === 'star' || c.kind === 'star' ? 2.5 : 4;
            const sep = skySeparation(a, c);
            if (c.kind === 'star' && skyAltAz(c.ra, c.dec, b.lst, loc.lat).alt < 3) continue;
            const key = `${a.name}|${c.name}`;
            if (sep < limit && (!pairs.has(key) || sep < pairs.get(key).sep)) pairs.set(key, { a: a.name, c: c.name, sep, t: b.t });
        }
    }
    for (const p of [...pairs.values()].sort((x, y) => x.sep - y.sep).slice(0, 4)) {
        out.push({ kind: 'pair', icon: '🤝', title: `${p.a} and ${p.c}`,
            detail: `${p.sep < 1 ? 'less than 1°' : `${p.sep.toFixed(1)}°`} apart around ${skyClock(p.t)} (a finger at arm's length is about 1°)` });
    }

    // Meteor showers on now, or the next big one
    const moonUp = best.length && best.filter(b => b.moon.alt > 0 && b.moon.illumination > 0.5).length > best.length / 2;
    let active = 0;
    for (const s of SKY_SHOWERS) {
        const dates = skyShowerDates(s, now);
        if (now < dates.from) continue;
        active++;
        const daysToPeak = Math.round((dates.peak - new Date(new Date(now).toDateString()).getTime()) / SKY_DAY);
        const radiant = best.reduce((top, b) => Math.max(top, skyAltAz(s.ra, s.dec, b.lst, loc.lat).alt), -90);
        const peakText = daysToPeak === 0 ? 'peaks tonight' : daysToPeak > 0 ? `peaks ${skyDay(dates.peak)}` : `peaked ${skyDay(dates.peak)}`;
        const rate = Math.abs(daysToPeak) <= 1 ? s.zhr : Math.max(1, Math.round(s.zhr / (1 + Math.abs(daysToPeak) / 2)));
        if (rate < 3 && !s.note) continue;
        out.push({ kind: 'meteor', icon: '☄️', title: `${s.name} meteor shower`,
            detail: `${peakText}; up to ~${rate} an hour in a dark sky${s.note ? `, ${s.note}` : ''}${radiant < 10 ? ', but the radiant is low tonight' : ''}${moonUp ? '. Moonlight will hide the fainter ones' : ''}` });
    }
    if (!active) {
        const next = SKY_SHOWERS.filter(s => s.zhr >= 50).map(s => ({ s, d: skyShowerDates(s, now) })).sort((a, b) => a.d.peak - b.d.peak)[0];
        if (next) out.push({ kind: 'meteor', icon: '☄️', title: `Next big meteor shower: ${next.s.name}`, detail: `peaks ${skyDay(next.d.peak)}, up to ~${next.s.zhr} an hour` });
    }

    // Algol dimming during the dark hours of the next three nights
    const algol = SKY_STAR_BY_NAME.Algol;
    const jdNow = skyJd(now);
    for (let n = Math.ceil((jdNow - ALGOL_EPOCH) / ALGOL_PERIOD); ; n++) {
        const jd = ALGOL_EPOCH + n * ALGOL_PERIOD;
        if (jd > jdNow + 3) break;
        const t = (jd - 2440587.5) * SKY_DAY;
        const b = skyBodies(t, loc);
        const alt = skyAltAz(algol[1], algol[2], b.lst, loc.lat).alt;
        if (b.sun.alt < -12 && alt > 20) {
            out.push({ kind: 'variable', icon: '👁️', title: `Algol dims ${skyDay(t)} around ${skyClock(t)}`,
                detail: 'The "demon star" in Perseus fades to a third of its brightness for a few hours as its companion passes in front (time ±1–2 h)' });
            break;
        }
    }

    // T Coronae Borealis, the recurrent nova
    if (best.some(b => skyAltAz(15.99, 25.92, b.lst, loc.lat).alt > 20)) {
        out.push({ kind: 'variable', icon: '💥', title: 'Watch the Northern Crown',
            detail: 'T Coronae Borealis, a recurrent nova near Alphecca, flares every ~80 years and has been due since 2024. If a "new" bright star appears there, that\'s it' });
    }

    // The best placed few deep-sky sights
    SKY_DEEP.map(([name, ra, dec, mag, what]) => {
        const top = best.reduce((top, b) => {
            const p = skyAltAz(ra, dec, b.lst, loc.lat);
            return p.alt > (top?.alt ?? -90) ? { ...p, t: b.t } : top;
        }, null);
        return { name, mag, what, top };
    }).filter(d => d.top?.alt > 40).sort((a, b) => b.top.alt - a.top.alt).slice(0, 3).forEach(({ name, mag, what, top }) => {
        out.push({ kind: 'deep', icon: '🌌', title: name, detail: `${what}; ${skyWhere(top.alt, top.az)} around ${skyClock(top.t)}${mag > 4.5 ? ' (binoculars)' : ''}` });
    });

    // Aurora chances: the Kp needed rises the further from the poles you are
    if (kp?.length && !night.noNight) {
        const nightKp = kp.filter(k => {
            const t = Date.parse(k.time);
            return t + 3 * SKY_HOUR > night.viewFrom && t < night.viewTo;
        });
        const maxKp = Math.max(...nightKp.map(k => k.kp), 0);
        const needed = skyAuroraKp(loc.lat);
        if (maxKp >= needed) {
            out.push({ kind: 'aurora', icon: '🌈', title: `Aurora possible tonight (Kp ${maxKp.toFixed(1)})`,
                detail: `Look ${loc.lat >= 0 ? 'north' : 'south'} from somewhere dark. A phone camera often picks it up before your eyes do` });
        } else if (maxKp >= needed - 1.5) {
            out.push({ kind: 'aurora-maybe', icon: '🌈', title: `Aurora: an outside chance (Kp ${maxKp.toFixed(1)})`,
                detail: `Around Kp ${needed} is usually needed this far ${loc.lat >= 0 ? 'south' : 'north'}; worth a camera shot to the ${loc.lat >= 0 ? 'north' : 'south'}` });
        }
    }
    const order = ['aurora', 'event', 'pair', 'planet', 'meteor', 'aurora-maybe', 'variable', 'faint', 'deep'];
    return out.map((h, i) => ({ h, i })).sort((a, b) => order.indexOf(a.h.kind) - order.indexOf(b.h.kind) || a.i - b.i).map(x => x.h);
}

// --- Tab ---

let skyLocation = null;
let skyKp = null;
let skyKpAt = 0;
let skyOffsetMinutes = 0;
let skyTimer = null;
let skyCache = null; // { key, night, highlights, moon }
let skyEclipseCache = null; // { key, list }: these take a few thousand position sums, so once a day

async function showSky() {
    setAppView('sky');
    if (!skyLocation) {
        try { skyLocation = await (await fetch('/api/sky/location')).json(); } catch { }
    }
    document.getElementById('sky-location-form').hidden = !!skyLocation;
    if (!skyLocation) fillSkyLocationForm();
    refreshSky();
}

function refreshSky() {
    clearTimeout(skyTimer);
    if (appView !== 'sky') return;
    if (!document.hidden) renderSky();
    skyTimer = setTimeout(refreshSky, 60000);
}

async function loadSkyKp() {
    if (skyKp && Date.now() - skyKpAt < 30 * 60000) return;
    skyKpAt = Date.now();
    try {
        const res = await fetch('/api/sky/kp');
        if (res.ok) { skyKp = await res.json(); skyCache = null; }
    } catch { }
}

function openSkyLocation() {
    const form = document.getElementById('sky-location-form');
    form.hidden = !form.hidden;
    if (!form.hidden) fillSkyLocationForm();
}

function fillSkyLocationForm() {
    document.getElementById('sky-lat').value = skyLocation?.lat ?? '';
    document.getElementById('sky-lon').value = skyLocation?.lon ?? '';
    document.getElementById('sky-name').value = skyLocation?.name ?? '';
}

function useDeviceSkyLocation() {
    if (!navigator.geolocation) return showToast('This browser can\'t share its location', 'error');
    navigator.geolocation.getCurrentPosition(pos => {
        document.getElementById('sky-lat').value = pos.coords.latitude.toFixed(4);
        document.getElementById('sky-lon').value = pos.coords.longitude.toFixed(4);
    }, err => showToast(window.isSecureContext ? `Couldn't get the location: ${err.message}` : 'The browser only shares its location over HTTPS. Type it in instead', 'error'),
    { timeout: 15000 });
}

async function saveSkyLocation() {
    const body = {
        lat: parseFloat(document.getElementById('sky-lat').value),
        lon: parseFloat(document.getElementById('sky-lon').value),
        name: document.getElementById('sky-name').value,
    };
    try {
        const res = await fetch('/api/sky/location', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        skyLocation = data;
        skyCache = null;
        document.getElementById('sky-location-form').hidden = true;
        renderSky();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function setSkyOffset(minutes) {
    skyOffsetMinutes = Number(minutes) || 0;
    document.getElementById('sky-time').value = skyOffsetMinutes;
    renderSkyChart();
}

async function renderSky() {
    const body = document.getElementById('sky-body');
    body.hidden = !skyLocation;
    document.getElementById('sky-place').textContent = skyLocation
        ? skyLocation.name || `${Math.abs(skyLocation.lat).toFixed(2)}°${skyLocation.lat >= 0 ? 'N' : 'S'} ${Math.abs(skyLocation.lon).toFixed(2)}°${skyLocation.lon >= 0 ? 'E' : 'W'}`
        : '';
    if (!skyLocation) return;
    renderSkyChart();
    await loadSkyKp();
    if (appView !== 'sky') return;
    renderSkyTonight();
}

// The tonight lists only change slowly: worked out again every 15 minutes, or when something changes
function skyTonight() {
    const now = Date.now();
    const key = `${skyLocation.lat},${skyLocation.lon},${Math.floor(now / (15 * 60000))},${!!skyKp}`;
    if (skyCache?.key === key) return skyCache;
    const night = skyNight(now, skyLocation);
    const samples = skyNightSamples(night, skyLocation);
    const b = skyBodies(now, skyLocation);
    const full = skyNextPhase(now, 180), newMoon = skyNextPhase(now, 0);
    skyCache = {
        key, night,
        highlights: skyHighlights(now, skyLocation, night, samples, skyKp),
        moon: { ...b.moon, ...skyMoonRiseSet(now, skyLocation), full, newMoon, fullKm: full ? skyMoon((skyJd(full) - 2451545) / 36525).km : null },
    };
    const eclipseKey = `${skyLocation.lat},${skyLocation.lon},${new Date(now).toDateString()}`;
    if (skyEclipseCache?.key !== eclipseKey) skyEclipseCache = { key: eclipseKey, list: skyEclipses(now, skyLocation) };
    skyCache.eclipses = skyEclipseCache.list;
    return skyCache;
}

function renderSkyTonight() {
    const { night, highlights, moon, eclipses } = skyTonight();
    const now = Date.now();
    const sunAlt = skySunAlt(now, skyLocation);
    const state = sunAlt > -0.833 ? 'Daylight' : sunAlt > -6 ? 'Twilight' : sunAlt > -12 ? 'Getting dark' : sunAlt > -18 ? 'Nearly dark' : 'Dark';
    const darkness = night.noNight ? 'The Sun doesn\'t set tonight'
        : night.neverDark ? `It never gets fully dark tonight: darkest around ${skyClock((night.viewFrom + night.viewTo) / 2)}`
        : `Fully dark ${skyClock(night.darkFrom)} – ${skyClock(night.darkTo)}`;
    const supermoon = moon.fullKm && moon.fullKm < 362000;

    document.getElementById('sky-summary').innerHTML = `
        <div class="sky-card">
            <div class="sky-card-title">Now: ${state}</div>
            <div class="sky-card-rows">
                ${night.sunset ? `<div><span>Sunset</span><b>${skyClock(night.sunset)}</b></div>` : ''}
                ${night.sunrise ? `<div><span>Sunrise</span><b>${skyClock(night.sunrise)}</b></div>` : ''}
            </div>
            <div class="sky-card-note">${darkness}</div>
        </div>
        <div class="sky-card">
            <div class="sky-card-title">${skyMoonIcon(moon.age, 34)} ${skyPhaseName(moon.age)}, ${Math.round(moon.illumination * 100)}% lit</div>
            <div class="sky-card-rows">
                ${moon.rise ? `<div><span>Rises</span><b>${skyClock(moon.rise)}</b></div>` : ''}
                ${moon.set ? `<div><span>Sets</span><b>${skyClock(moon.set)}</b></div>` : ''}
            </div>
            <div class="sky-card-note">
                ${moon.full ? `${skyFullMoonName(moon.full)} ${skyDay(moon.full)}${supermoon ? ' — a supermoon, closer and brighter than usual' : ''}` : ''}
                ${moon.newMoon ? `<br>New moon ${skyDay(moon.newMoon)}: the best dark skies` : ''}
            </div>
        </div>`;

    const list = document.getElementById('sky-highlights');
    list.innerHTML = highlights.length ? highlights.map(h => `
        <div class="sky-item sky-${h.kind}">
            <span class="sky-item-icon" aria-hidden="true">${h.icon}</span>
            <div><div class="sky-item-title">${escapeHtml(h.title)}</div><div class="sky-item-detail">${escapeHtml(h.detail)}</div></div>
        </div>`).join('') : '<div class="sky-empty">Nothing special tonight. Just the stars.</div>';

    document.getElementById('sky-eclipses').innerHTML = eclipses.length ? eclipses.map(e => `
        <div class="sky-item sky-event">
            <span class="sky-item-icon" aria-hidden="true">${e.text.startsWith('Solar') ? '🌑' : '🌕'}</span>
            <div><div class="sky-item-title">${e.text} ${skyDay(e.t)}, ${new Date(e.t).getFullYear()}</div>
            <div class="sky-item-detail">Around ${skyClock(e.t)}: ${escapeHtml(e.detail)} (approximate)</div></div>
        </div>`).join('') : '<div class="sky-empty">None that can be seen from here in the next two years.</div>';

    renderSkyKp(night);
}

// Kp, three-hourly, from a day ago through NOAA's forecast: bars in status colours, each labelled
function renderSkyKp(night) {
    const el = document.getElementById('sky-kp');
    if (!skyKp?.length) { el.innerHTML = '<div class="sky-empty">Aurora forecast unavailable</div>'; return; }
    const now = Date.now();
    const rows = skyKp.filter(k => Date.parse(k.time) > now - SKY_DAY);
    const needed = skyAuroraKp(skyLocation.lat);
    const level = kp => kp >= needed ? 'high' : kp >= 5 ? 'storm' : kp >= 4 ? 'active' : 'quiet';
    const label = { quiet: 'Quiet', active: 'Active', storm: 'Storm', high: 'Aurora likely here' };
    let lastDay = '';
    el.innerHTML = `
        <div class="sky-kp-bars" role="list">
            ${rows.map(k => {
                const t = Date.parse(k.time);
                const day = new Date(t).toLocaleDateString([], { weekday: 'short' });
                const showDay = day !== lastDay; lastDay = day;
                const isNow = now >= t && now < t + 3 * SKY_HOUR;
                const dark = t + 3 * SKY_HOUR > night.viewFrom && t < night.viewTo;
                const tip = `${skyDay(t)} ${skyClock(t)}: Kp ${k.kp.toFixed(1)}, ${label[level(k.kp)]}${k.observed === 'predicted' ? ' (forecast)' : ''}`;
                return `<div class="sky-kp-col${isNow ? ' now' : ''}${dark ? ' dark' : ''}" role="listitem" title="${tip}" aria-label="${tip}" onclick="document.getElementById('sky-kp-detail').textContent = this.title">
                    <div class="sky-kp-bar ${level(k.kp)}${k.observed === 'predicted' ? ' predicted' : ''}" style="height:${Math.max(4, k.kp / 9 * 100)}%"></div>
                    <div class="sky-kp-day">${showDay ? day : ''}</div>
                </div>`;
            }).join('')}
        </div>
        <div id="sky-kp-detail" class="sky-kp-detail">Tap a bar for its time and Kp</div>
        <div class="sky-kp-key">
            <span><i class="quiet"></i>Quiet</span><span><i class="active"></i>Active (Kp 4)</span>
            <span><i class="storm"></i>Storm (Kp 5+)</span><span><i class="high"></i>Kp ${needed}+: aurora possible here</span>
            <span class="sky-kp-faded">Faded: forecast</span>
        </div>`;
}

// A Moon icon: lit part on the right while waxing (northern-hemisphere view)
function skyMoonIcon(age, size) {
    const r = size / 2 - 1;
    const k = (1 - skyCos(age)) / 2;
    const t = r * Math.abs(1 - 2 * k);
    const waxing = age < 180;
    const path = `M0,${-r} A${r},${r} 0 0 1 0,${r} A${t},${r} 0 0 ${k > 0.5 ? 1 : 0} 0,${-r}Z`;
    return `<svg class="sky-moon-icon" width="${size}" height="${size}" viewBox="${-size / 2} ${-size / 2} ${size} ${size}" aria-hidden="true">
        <circle r="${r}" fill="#334155"/><path d="${path}" fill="#f1f5f9" transform="${waxing ? '' : 'scale(-1,1)'}"/></svg>`;
}

// --- The chart, drawn two ways. Overhead: the whole sky as a disc, zenith in the middle, horizon round the
// edge, north at the top and east on the left, as if lying on your back with your head to the north.
// Looking out: standing up facing a compass direction, through a wide-angle (stereographic) lens.

const SKY_SIZE = 1000, SKY_R = 470;
const SKY_W = 1200, SKY_H = 675;
const SKY_LOOK_ALT = 25;   // the lens points this far above the horizon
const SKY_HALF_WIDTH = 62; // and takes in this far either side of where you're facing

let skyMode = localStorage.getItem('skyChartMode') === 'dome' ? 'dome' : 'horizon';
let skyFacing = 0; // the compass direction faced, degrees from north

function skyDomeProject(alt, az) {
    const r = (90 - alt) / 90 * SKY_R;
    return [SKY_SIZE / 2 - r * skySin(az), SKY_SIZE / 2 - r * skyCos(az)];
}

// A projection facing the given azimuth: alt/az -> [x, y], or null when it's behind you or off the edge
function skyHorizonProject(facing) {
    const h0 = SKY_LOOK_ALT;
    const raw = (alt, az) => {
        const dA = skyNorm(az - facing + 180) - 180;
        const cosC = skySin(h0) * skySin(alt) + skyCos(h0) * skyCos(alt) * skyCos(dA);
        if (cosC < 0.05) return null;
        const k = 2 / (1 + cosC);
        return [k * skyCos(alt) * skySin(dA), k * (skyCos(h0) * skySin(alt) - skySin(h0) * skyCos(alt) * skyCos(dA))];
    };
    const scale = SKY_W / 2 / raw(0, facing + SKY_HALF_WIDTH)[0];
    const cy = SKY_H * 0.84 + raw(0, facing)[1] * scale; // the horizon straight ahead sits near the bottom
    return (alt, az) => {
        const p = raw(alt, az);
        if (!p) return null;
        const x = SKY_W / 2 + p[0] * scale, y = cy - p[1] * scale;
        return x < -200 || x > SKY_W + 200 || y < -200 || y > SKY_H + 200 ? null : [x, y];
    };
}

// Unit vector of an altitude/azimuth, and back
const skyVec = (alt, az) => [skyCos(alt) * skyCos(az), skyCos(alt) * skySin(az), skySin(alt)];
const skyFromVec = v => ({ alt: Math.asin(v[2] / Math.hypot(...v)) / SKY_DEG, az: skyNorm(Math.atan2(v[1], v[0]) / SKY_DEG) });

function setSkyMode(mode) {
    skyMode = mode;
    try { localStorage.setItem('skyChartMode', mode); } catch { }
    renderSkyChart();
}

function setSkyFacing(deg) {
    skyFacing = skyNorm(Math.round(Number(deg) || 0)); // turns round and round
    renderSkyChart();
}

function renderSkyChart() {
    const t = Date.now() + skyOffsetMinutes * 60000;
    const loc = skyLocation;
    const b = skyBodies(t, loc);
    const sunAlt = b.sun.alt;
    const horizon = skyMode === 'horizon';
    const project = horizon ? skyHorizonProject(skyFacing) : skyDomeProject;
    const starFade = sunAlt > -0.833 ? 0.25 : sunAlt > -6 ? 0.45 : sunAlt > -12 ? 0.75 : 1;
    const sky = sunAlt > -0.833 ? ['#2f5f99', '#1e3a66'] : sunAlt > -6 ? ['#233e6b', '#121e3d'] : sunAlt > -12 ? ['#121c3a', '#0a1028'] : ['#0a0f24', '#03050f'];
    const parts = [], frame = [];
    const labels = []; // { x, y, r, text, cls, size, priority }: placed last so they don't overlap
    const pos = (ra, dec) => skyAltAz(ra, dec, b.lst, loc.lat);
    const fmt = n => n.toFixed(1);
    const at = (alt, az) => alt >= 0 ? project(alt, az) : null; // where it is on the chart, if it's up and in view
    // A path through [alt, az] points, lifting the pen where they go below the horizon or out of view
    const trace = points => {
        let d = '', pen = false;
        for (const [alt, az] of points) {
            const xy = at(alt, az);
            if (!xy) { pen = false; continue; }
            d += `${pen ? 'L' : 'M'}${fmt(xy[0])},${fmt(xy[1])}`;
            pen = true;
        }
        return d;
    };

    // Grid: altitude lines, and the compass points
    for (const a of [30, 60]) {
        if (horizon) {
            const pts = [];
            for (let dA = -120; dA <= 120; dA += 3) pts.push([a, skyFacing + dA]);
            parts.push(`<path d="${trace(pts)}" class="sky-grid"/>`);
            const xy = project(a, skyFacing - SKY_HALF_WIDTH + 6);
            if (xy) parts.push(`<text x="${fmt(xy[0])}" y="${fmt(xy[1] - 6)}" class="sky-grid-label">${a}°</text>`);
        } else {
            parts.push(`<circle cx="500" cy="500" r="${(90 - a) / 90 * SKY_R}" class="sky-grid"/>`);
        }
    }
    if (!horizon) for (const [label, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
        const [x, y] = project(-6, az);
        frame.push(`<text x="${fmt(x)}" y="${fmt(y)}" class="sky-compass">${label}</text>`);
    }

    // Ecliptic, the path of the Sun, Moon and planets
    const ecliptic = [];
    for (let lon = 0; lon <= 360; lon += 2) {
        const e = skyEclToEq(lon, 0);
        const p = pos(e.ra, e.dec);
        ecliptic.push([p.alt, p.az]);
    }
    const eclPath = trace(ecliptic);
    if (eclPath) parts.push(`<path d="${eclPath}" class="sky-ecliptic"/>`);

    // Constellation figures, and their names where most of the figure is in view
    const starPos = new Map();
    for (const s of SKY_STARS) {
        const p = pos(s[1], s[2]);
        starPos.set(s[0], { ...p, xy: at(p.alt, p.az) });
    }
    for (const [name, chains] of Object.entries(SKY_FIGURES)) {
        let d = '';
        const up = [];
        for (const chain of chains) for (let i = 1; i < chain.length; i++) {
            const a = starPos.get(chain[i - 1]), c = starPos.get(chain[i]);
            if (!a?.xy || !c?.xy) continue;
            d += `M${fmt(a.xy[0])},${fmt(a.xy[1])}L${fmt(c.xy[0])},${fmt(c.xy[1])}`;
        }
        for (const s of new Set(chains.flat())) if (starPos.get(s)?.xy) up.push(starPos.get(s).xy);
        if (d) parts.push(`<path d="${d}" class="sky-figure"/>`);
        if (up.length >= new Set(chains.flat()).size * 0.6) {
            const cx = up.reduce((s, p) => s + p[0], 0) / up.length, cy = up.reduce((s, p) => s + p[1], 0) / up.length;
            labels.push({ x: cx, y: cy + 20, r: 0, text: name.toUpperCase(), cls: 'sky-con-name', size: 15, priority: 4, centred: true });
        }
    }

    // Deep-sky objects
    for (const [name, ra, dec, mag, what] of SKY_DEEP) {
        const p = pos(ra, dec);
        const xy = at(p.alt, p.az);
        if (!xy) continue;
        const [x, y] = xy;
        parts.push(`<g class="sky-hit" data-info="${skyAttr(`${name}: ${what}. ${skyWhere(p.alt, p.az)}`)}">
            <circle cx="${fmt(x)}" cy="${fmt(y)}" r="16" class="sky-target"/>
            <ellipse cx="${fmt(x)}" cy="${fmt(y)}" rx="7" ry="4.5" class="sky-deep"/></g>`);
        labels.push({ x, y, r: 8, text: name, cls: 'sky-deep-name', size: 13, priority: 3 });
    }

    // Stars, bigger for brighter
    for (const s of SKY_STARS) {
        const p = starPos.get(s[0]);
        if (!p.xy) continue;
        const [x, y] = p.xy;
        const r = Math.max(1.3, 6.2 - 1.25 * s[3]);
        if (s[3] < 1.0) labels.push({ x, y, r, text: s[0], cls: 'sky-star-name', size: 16, priority: 2 });
        parts.push(`<g class="sky-hit" data-info="${skyAttr(`${s[0]}: magnitude ${skyMag(s[3])}, ${skyWhere(p.alt, p.az)}`)}">
            <circle cx="${fmt(x)}" cy="${fmt(y)}" r="${Math.max(r + 6, 12)}" class="sky-target"/>
            <circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(r)}" fill="${s[4] || '#f4f7ff'}" class="sky-star"/></g>`);
    }

    // Planets, labelled
    for (const p of b.planets) {
        const xy = at(p.alt, p.az);
        if (!xy) continue;
        const [x, y] = xy;
        const r = Math.max(3, Math.min(9, 6.5 - 1.1 * p.mag));
        parts.push(`<g class="sky-hit" data-info="${skyAttr(`${p.name}: magnitude ${skyMag(p.mag)}, ${skyWhere(p.alt, p.az)}, ${p.delta.toFixed(2)} AU (${Math.round(p.delta * 8.317)} light minutes) away`)}">
            <circle cx="${fmt(x)}" cy="${fmt(y)}" r="18" class="sky-target"/>
            <circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(r)}" fill="${p.colour}" class="sky-planet"/></g>`);
        // In daylight the ones beside the Sun can't be seen anyway
        if (!(sunAlt > -6 && p.elongation < 12)) labels.push({ x, y, r, text: p.name, cls: 'sky-planet-name', size: 19, priority: 1 });
    }

    // The Moon, its lit side turned towards the Sun
    const moonXY = b.moon.alt > -1 && project(b.moon.alt, b.moon.az);
    if (moonXY) {
        const [x, y] = moonXY;
        // Which way the Sun is: a point a short way from the Moon towards it, which is in view even when the Sun isn't
        const m = skyVec(b.moon.alt, b.moon.az), sv = skyVec(b.sun.alt, b.sun.az);
        const dot = m[0] * sv[0] + m[1] * sv[1] + m[2] * sv[2];
        const towards = skyFromVec(m.map((v, i) => v + 0.02 * (sv[i] - v * dot)));
        const [sx, sy] = project(towards.alt, towards.az) || [x + 1, y];
        const angle = Math.atan2(sy - y, sx - x) / SKY_DEG;
        const r = 15, k = b.moon.illumination, tr = r * Math.abs(1 - 2 * k);
        parts.push(`<g class="sky-hit" data-info="${skyAttr(`Moon: ${skyPhaseName(b.moon.age)}, ${Math.round(k * 100)}% lit, ${skyWhere(b.moon.alt, b.moon.az)}, ${Math.round(b.moon.km).toLocaleString()} km away`)}">
            <circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r + 3}" class="sky-moon-glow"/>
            <circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r}" fill="#3b4459"/>
            <path d="M0,${-r} A${r},${r} 0 0 1 0,${r} A${fmt(tr)},${r} 0 0 ${k > 0.5 ? 1 : 0} 0,${-r}Z" fill="#f1f5f9"
                transform="translate(${fmt(x)},${fmt(y)}) rotate(${fmt(angle)})"/></g>`);
        labels.push({ x, y, r, text: 'Moon', cls: 'sky-planet-name', size: 19, priority: 0 });
    }

    // The Sun, when it's up
    const sunXY = b.sun.alt > -1 && project(b.sun.alt, b.sun.az);
    if (sunXY) parts.push(`<circle cx="${fmt(sunXY[0])}" cy="${fmt(sunXY[1])}" r="16" fill="#fde68a" class="sky-sun"/>`);

    parts.push(...skyPlaceLabels(labels));

    let svg;
    if (horizon) {
        // The ground covers everything below the horizon, with the compass points marked along its edge
        const edge = [];
        for (let dA = -110; dA <= 110; dA += 2) {
            const xy = project(0, skyFacing + dA);
            if (xy) edge.push(`${fmt(xy[0])},${fmt(xy[1])}`);
        }
        frame.push(`<path d="M${edge.join('L')}L${SKY_W + 200},${SKY_H + 200}L-200,${SKY_H + 200}Z" class="sky-ground"/>`);
        for (let i = 0; i < 16; i++) {
            const xy = project(0, i * 22.5);
            if (!xy || xy[0] < 20 || xy[0] > SKY_W - 20) continue;
            const main = i % 4 === 0;
            frame.push(`<line x1="${fmt(xy[0])}" y1="${fmt(xy[1])}" x2="${fmt(xy[0])}" y2="${fmt(xy[1] + (main ? 14 : 8))}" class="sky-tick"/>
                <text x="${fmt(xy[0])}" y="${fmt(xy[1] + (main ? 42 : 34))}" class="sky-compass${main ? '' : ' minor'}">${SKY_COMPASS[i]}</text>`);
        }
        svg = `<svg viewBox="0 0 ${SKY_W} ${SKY_H}" class="sky-svg" role="img" aria-label="The sky looking ${skyCompass(skyFacing)}">
            <defs><linearGradient id="sky-dome" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${sky[1]}"/><stop offset="100%" stop-color="${sky[0]}"/></linearGradient></defs>
            <rect width="${SKY_W}" height="${SKY_H}" fill="url(#sky-dome)"/>
            <g style="--sky-fade:${starFade}">${parts.join('')}</g>
            ${frame.join('')}
        </svg>`;
    } else {
        svg = `<svg viewBox="-30 -30 1060 1060" class="sky-svg" role="img" aria-label="The sky overhead">
            <defs><radialGradient id="sky-dome"><stop offset="0%" stop-color="${sky[1]}"/><stop offset="100%" stop-color="${sky[0]}"/></radialGradient>
                <clipPath id="sky-clip"><circle cx="500" cy="500" r="${SKY_R}"/></clipPath></defs>
            <circle cx="500" cy="500" r="${SKY_R}" fill="url(#sky-dome)"/>
            <g clip-path="url(#sky-clip)" style="--sky-fade:${starFade}">${parts.join('')}</g>
            <circle cx="500" cy="500" r="${SKY_R}" class="sky-horizon"/>
            ${frame.join('')}
        </svg>`;
    }
    const chart = document.getElementById('sky-chart');
    chart.innerHTML = svg;
    chart.classList.toggle('horizon', horizon);
    document.querySelectorAll('.sky-mode-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === skyMode));
    document.getElementById('sky-facing-row').hidden = !horizon;
    document.getElementById('sky-facing-label').textContent = `Facing ${skyCompass(skyFacing)} (${skyFacing}°)`;

    const when = new Date(t);
    document.getElementById('sky-time-label').textContent = skyOffsetMinutes
        ? `${when.toLocaleDateString([], { weekday: 'short' })} ${skyClock(t)} (+${Math.floor(skyOffsetMinutes / 60)}h${skyOffsetMinutes % 60 ? ` ${skyOffsetMinutes % 60}m` : ''})`
        : `Now, ${skyClock(t)}`;
    document.getElementById('sky-info').textContent = sunAlt > -6
        ? 'The Sun is up or it\'s still twilight, so most of these won\'t show yet. Slide the time on to see tonight.'
        : `Tap a star, planet or the Moon to see what it is.${horizon ? ' Drag the sky to turn round.' : ''}`;
}

// Labels in order of importance, each beside its mark wherever it first fits; any that can't fit are left off
function skyPlaceLabels(labels) {
    const placed = [], out = [];
    const overlaps = b => placed.some(o => b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1);
    for (const l of labels.sort((a, b) => a.priority - b.priority)) {
        const w = l.text.length * l.size * 0.56, h = l.size;
        const gap = l.r + 4;
        const spots = l.centred ? [[-w / 2, 0], [-w / 2, -h - 20]]
            : [[gap, h * 0.35], [gap, -gap], [-gap - w, h * 0.35], [gap, gap + h * 0.7], [-w / 2, -gap - 2], [-w / 2, gap + h]];
        for (const [dx, dy] of spots) {
            const box = { x1: l.x + dx, x2: l.x + dx + w, y1: l.y + dy - h * 0.85, y2: l.y + dy + h * 0.2 };
            if (overlaps(box)) continue;
            placed.push(box);
            out.push(`<text x="${(l.x + dx).toFixed(1)}" y="${(l.y + dy).toFixed(1)}" class="${l.cls}">${escapeHtml(l.text)}</text>`);
            break;
        }
    }
    return out;
}

// Dragging the looking-out view turns you round: the sky follows your finger
const skyChartEl = document.getElementById('sky-chart');
let skyDrag = null; // { x, lastX, facing, moved }
let skyDragFrame = 0;
// Turn to match how far the pointer has gone since the drag started (the view is SKY_HALF_WIDTH * 2 degrees across)
const turnSkyDrag = () => {
    if (!skyDrag?.moved) return;
    const degPerPx = SKY_HALF_WIDTH * 2 / skyChartEl.clientWidth;
    const facing = skyNorm(Math.round(skyDrag.facing - (skyDrag.lastX - skyDrag.x) * degPerPx));
    if (facing !== skyFacing) setSkyFacing(facing);
};
skyChartEl?.addEventListener('pointerdown', e => {
    if (skyMode !== 'horizon') return;
    skyDrag = { x: e.clientX, lastX: e.clientX, facing: skyFacing, moved: false };
});
skyChartEl?.addEventListener('pointermove', e => {
    if (!skyDrag) return;
    skyDrag.lastX = e.clientX;
    if (!skyDrag.moved && Math.abs(e.clientX - skyDrag.x) > 6) {
        skyDrag.moved = true;
        try { skyChartEl.setPointerCapture(e.pointerId); } catch { } // keeps the drag going off the edge
    }
    if (skyDrag.moved && !skyDragFrame) skyDragFrame = requestAnimationFrame(() => { skyDragFrame = 0; turnSkyDrag(); });
});
const endSkyDrag = () => {
    turnSkyDrag(); // wherever the pointer was let go, even if no frame has drawn it yet
    if (skyDrag?.moved) skyChartEl.dataset.dragged = '1'; // the click that ends a drag isn't a tap
    skyDrag = null;
};
skyChartEl?.addEventListener('pointerup', endSkyDrag);
skyChartEl?.addEventListener('pointercancel', endSkyDrag);
skyChartEl?.addEventListener('click', e => {
    if (skyChartEl.dataset.dragged) { delete skyChartEl.dataset.dragged; return; }
    const hit = e.target.closest('.sky-hit');
    if (hit) document.getElementById('sky-info').textContent = hit.dataset.info;
});
