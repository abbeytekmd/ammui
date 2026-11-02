// The night sky for the slideshow: the stars, constellation figures, planets and Moon as they are
// now from the slideshow's location, worked out here in the browser and drawn as if looking out
// at the horizon. Positions are low precision (a fraction of a degree), plenty for a picture.

const SKY_DEG = Math.PI / 180;
const skySin = d => Math.sin(d * SKY_DEG);
const skyCos = d => Math.cos(d * SKY_DEG);
const skyNorm = d => ((d % 360) + 360) % 360;
const skyJd = t => t / 86400000 + 2440587.5; // ms since 1970 -> Julian day
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

// The Sun's altitude alone (skyBodies works out the planets too)
function skySunAlt(t, loc) {
    const jd = skyJd(t);
    const earth = skyHelio(SKY_PLANETS[2], (jd - 2451545) / 36525);
    const sun = skyEclToEq(skyNorm(Math.atan2(-earth[1], -earth[0]) / SKY_DEG), 0);
    return skyAltAz(sun.ra, sun.dec, skyLst(jd, loc.lon), loc.lat).alt;
}

// The next sunrise and sunset after t (ms), either null where it doesn't happen in the next two
// days (midsummer or midwinter far north or south). The Sun's top edge on the horizon, as usual.
function skyNextSunriseSunset(t, loc) {
    const level = -0.833, step = 10 * 60000;
    const out = { rise: null, set: null };
    let prev = skySunAlt(t, loc) - level;
    for (let at = t + step; at <= t + 2 * 86400000 && (out.rise === null || out.set === null); at += step) {
        const v = skySunAlt(at, loc) - level;
        if ((prev < 0) !== (v < 0)) {
            const when = Math.round(at - step + step * prev / (prev - v));
            if (v > 0) out.rise ??= when; else out.set ??= when;
        }
        prev = v;
    }
    return out;
}

const SKY_COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

// Unit vector of an altitude/azimuth, and back
const skyVec = (alt, az) => [skyCos(alt) * skyCos(az), skyCos(alt) * skySin(az), skySin(alt)];
const skyFromVec = v => ({ alt: Math.asin(v[2] / Math.hypot(...v)) / SKY_DEG, az: skyNorm(Math.atan2(v[1], v[0]) / SKY_DEG) });

// --- The picture: standing up facing a compass direction, looking out through a wide-angle
// (stereographic) lens, from the horizon near the bottom to straight overhead at the top. It's
// SKY_H units high and as wide as the screen's shape makes it, taking in more sky either side
// on a wider screen.

const SKY_H = 675;
const SKY_LOOK_ALT = 45;     // the lens points half way up, between the horizon and overhead
const SKY_HORIZON_AT = 0.93; // the horizon straight ahead, this far down (leaving just room for the compass points)
const SKY_ZENITH_AT = 0.03;  // straight overhead, this far down

// A projection facing the given azimuth in a picture w wide: alt/az -> [x, y], or null when it's
// behind you or off the edge
function skyLensProject(facing, w) {
    const h0 = SKY_LOOK_ALT;
    const raw = (alt, az) => {
        const dA = skyNorm(az - facing + 180) - 180;
        const cosC = skySin(h0) * skySin(alt) + skyCos(h0) * skyCos(alt) * skyCos(dA);
        if (cosC < -0.6) return null; // well behind you (the lens takes in more than half the sky)
        const k = 2 / (1 + cosC);
        return [k * skyCos(alt) * skySin(dA), k * (skyCos(h0) * skySin(alt) - skySin(h0) * skyCos(alt) * skyCos(dA))];
    };
    const horizon = raw(0, facing)[1], zenith = raw(90, facing)[1];
    const scale = (SKY_HORIZON_AT - SKY_ZENITH_AT) * SKY_H / (zenith - horizon);
    const cy = SKY_HORIZON_AT * SKY_H + horizon * scale;
    const place = p => [w / 2 + p[0] * scale, cy - p[1] * scale];
    const project = (alt, az) => {
        const p = raw(alt, az);
        if (!p) return null;
        const [x, y] = place(p);
        return x < -200 || x > w + 200 || y < -200 || y > SKY_H + 200 ? null : [x, y];
    };
    // The same, however far out of the picture it is (for the horizon, which runs off the sides)
    project.unbounded = (alt, az) => { const p = raw(alt, az); return p && place(p); };
    return project;
}

// The sky's colours by the Sun's altitude, blended between these: [altitude, overhead, horizon].
// Deep blue night, purple then pink and orange twilight, golden low sun, blue day.
const SKY_COLOURS = [
    [-90, '#02040b', '#060a1a'],
    [-18, '#02040b', '#0a1030'],
    [-12, '#080e2c', '#1d2150'],
    [-8, '#111940', '#3b3066'],
    [-4, '#1b2858', '#93587a'],
    [-1, '#273f78', '#de7f5a'],
    [3, '#3760a6', '#f0ae78'],
    [10, '#3c76c6', '#b6d2ee'],
    [90, '#2867cc', '#a4cbf2'],
];
const skyRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const skyMix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const skyCss = rgb => `rgb(${rgb.join(',')})`;
// Linear between the points of a table of [x, value] pairs (x ascending), held at the ends
const skyRamp = (table, x) => {
    if (x <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
        if (x <= table[i][0]) {
            const [x0, y0] = table[i - 1], [x1, y1] = table[i];
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
        }
    }
    return table[table.length - 1][1];
};

function skyColoursAt(sunAlt) {
    let i = SKY_COLOURS.findIndex(c => c[0] >= sunAlt);
    if (i < 0) i = SKY_COLOURS.length - 1;
    if (i === 0) i = 1;
    const [a0, top0, hor0] = SKY_COLOURS[i - 1], [a1, top1, hor1] = SKY_COLOURS[i];
    const k = Math.min(1, Math.max(0, (sunAlt - a0) / (a1 - a0)));
    return { top: skyMix(skyRgb(top0), skyRgb(top1), k), horizon: skyMix(skyRgb(hor0), skyRgb(hor1), k) };
}

// The faintest star that shows, by the Sun's altitude: about magnitude 6 in a dark sky, fewer
// and fewer through twilight. By day they all show anyway (it's a picture to read, not a photo).
const skyLimitingMag = sunAlt => skyRamp([[-18, 6], [-12, 4.3], [-6, 2.6], [-1, 1.2], [5, -0.5]], sunAlt);

// How strongly a star or planet of this magnitude shows: 0 to 1
function skyStarShow(mag, scene) {
    const seen = Math.min(1, Math.max(0, (scene.limitMag - mag + 0.8) / 1.6));
    const bright = 0.5 + 0.5 * Math.min(1, Math.max(0, (3.5 - mag) / 4)); // brighter stars brighter
    const day = skyRamp([[-8, 0], [-3, 0.75]], scene.sunAlt);
    return Math.max(seen, day) * bright;
}

// Where everything is in the sky at a moment, seen from loc. This is the slow part, so it's
// worked out once a minute and the picture drawn from it as often as it turns.
function skyScene(t, loc) {
    const b = skyBodies(t, loc);
    const sunAlt = b.sun.alt;
    const pos = (ra, dec) => skyAltAz(ra, dec, b.lst, loc.lat);
    const ecliptic = [];
    for (let lon = 0; lon <= 360; lon += 2) {
        const e = skyEclToEq(lon, 0);
        const p = pos(e.ra, e.dec);
        ecliptic.push([p.alt, p.az]);
    }
    // Which way the Moon's lit side faces: a point a short way from it towards the Sun
    const m = skyVec(b.moon.alt, b.moon.az), sv = skyVec(b.sun.alt, b.sun.az);
    const dot = m[0] * sv[0] + m[1] * sv[1] + m[2] * sv[2];
    return {
        sunAlt,
        limitMag: skyLimitingMag(sunAlt),
        light: sunAlt > -4, // a pale sky: stars get a dark edge and the lines a darker colour to stand out
        figureFade: Math.min(1, Math.max(0.7, (-sunAlt - 2) / 10)), // constellation lines
        labelFade: Math.min(1, Math.max(0.8, (-sunAlt - 2) / 10)),  // and their names, kept readable by day
        colours: skyColoursAt(sunAlt),
        // The warm glow on the horizon where the Sun is setting or rising (strongest just after sunset),
        // and the brightness round the Sun when it's up
        glow: Math.max(0, 1 - Math.abs(sunAlt + 1) / 11),
        halo: Math.min(1, Math.max(0, (sunAlt + 1) / 4)),
        ecliptic,
        stars: new Map(SKY_STARS.map(s => [s[0], { ...pos(s[1], s[2]), mag: s[3], colour: s[4] }])),
        deep: SKY_DEEP.map(([name, ra, dec, mag]) => ({ name, mag, ...pos(ra, dec) })),
        planets: b.planets,
        sun: b.sun,
        moon:{ ...b.moon, towards: skyFromVec(m.map((v, i) => v + 0.02 * (sv[i] - v * dot))) },
    };
}

// The picture of a scene looking towards `facing`, w units wide
function skyLensSvg(scene, facing, w) {
    const project = skyLensProject(facing, w);
    const parts = [], frame = [];
    const labels = []; // { x, y, r, text, cls, size, priority }: placed last so they don't overlap
    const fmt = n => n.toFixed(1);
    const at = (alt, az) => alt >= 0 ? project(alt, az) : null; // where it is in the picture, if it's up and in view
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

    // Altitude lines
    for (const a of [30, 60]) {
        const pts = [];
        for (let dA = -120; dA <= 120; dA += 3) pts.push([a, facing + dA]);
        parts.push(`<path d="${trace(pts)}" class="sky-grid"/>`);
    }

    // Ecliptic, the path of the Sun, Moon and planets
    const eclPath = trace(scene.ecliptic);
    if (eclPath) parts.push(`<path d="${eclPath}" class="sky-ecliptic"/>`);

    // Constellation figures, and their names where most of the figure is in view
    const starXY = new Map();
    for (const [name, s] of scene.stars) starXY.set(name, at(s.alt, s.az));
    for (const [name, chains] of Object.entries(SKY_FIGURES)) {
        let d = '';
        for (const chain of chains) for (let i = 1; i < chain.length; i++) {
            const a = starXY.get(chain[i - 1]), c = starXY.get(chain[i]);
            if (a && c) d += `M${fmt(a[0])},${fmt(a[1])}L${fmt(c[0])},${fmt(c[1])}`;
        }
        if (d) parts.push(`<path d="${d}" class="sky-figure"/>`);
        const stars = [...new Set(chains.flat())];
        const up = stars.map(s => starXY.get(s)).filter(Boolean);
        if (up.length >= stars.length * 0.6) {
            const cx = up.reduce((s, p) => s + p[0], 0) / up.length, cy = up.reduce((s, p) => s + p[1], 0) / up.length;
            labels.push({ x: cx, y: cy + 20, r: 0, text: name.toUpperCase(), cls: 'sky-con-name', size: 15, priority: 4, centred: true });
        }
    }

    // Galaxies, clusters and nebulae, once it's dark enough for them (they're faint and spread out)
    for (const d of scene.deep) {
        const xy = at(d.alt, d.az);
        const show = Math.min(1, Math.max(0, (scene.limitMag - d.mag - 0.5) / 1.5));
        if (!xy || show < 0.3) continue;
        parts.push(`<ellipse cx="${fmt(xy[0])}" cy="${fmt(xy[1])}" rx="7" ry="4.5" class="sky-deep" opacity="${show.toFixed(2)}"/>`);
        labels.push({ x: xy[0], y: xy[1], r: 8, text: d.name, cls: 'sky-deep-name', size: 13, priority: 3 });
    }

    // Stars: white, bigger and brighter for brighter ones, the brightest in a nimbus of light, and
    // at night the faint ones only once it's dark enough for them
    const starEdge = scene.light ? ' stroke="rgba(10,22,50,0.55)" stroke-width="1"' : '';
    for (const [name, s] of scene.stars) {
        const xy = starXY.get(name);
        if (!xy) continue;
        const show = skyStarShow(s.mag, scene);
        if (show < 0.03) continue;
        const r = Math.max(1, 5.4 - 1.15 * s.mag);
        if (s.mag < 1.8) {
            const nimbus = show * Math.min(1, (1.8 - s.mag) / 2.2);
            parts.push(`<circle cx="${fmt(xy[0])}" cy="${fmt(xy[1])}" r="${fmt(r * 4.5)}" fill="url(#sky-star-glow)" opacity="${nimbus.toFixed(2)}"/>`);
        }
        if (s.mag < 1.0 && show > 0.3) labels.push({ x: xy[0], y: xy[1], r, text: name, cls: 'sky-star-name', size: 16, priority: 2 });
        parts.push(`<circle cx="${fmt(xy[0])}" cy="${fmt(xy[1])}" r="${fmt(r)}" fill="#ffffff" opacity="${show.toFixed(2)}"${starEdge}/>`);
    }

    // Planets, labelled
    for (const p of scene.planets) {
        const xy = at(p.alt, p.az);
        if (!xy) continue;
        const r = Math.max(3, Math.min(9, 6.5 - 1.1 * p.mag));
        const show = Math.max(0.35, skyStarShow(p.mag, scene));
        if (p.mag < 0) parts.push(`<circle cx="${fmt(xy[0])}" cy="${fmt(xy[1])}" r="${fmt(r * 3.2)}" fill="url(#sky-star-glow)" opacity="${(show * 0.8).toFixed(2)}"/>`);
        parts.push(`<circle cx="${fmt(xy[0])}" cy="${fmt(xy[1])}" r="${fmt(r)}" fill="${p.colour}" opacity="${show.toFixed(2)}" class="sky-planet"/>`);
        // In twilight the ones beside the Sun can't be seen anyway
        if (!(scene.sunAlt > -6 && p.elongation < 12)) labels.push({ x: xy[0], y: xy[1], r, text: p.name, cls: 'sky-planet-name', size: 19, priority: 1 });
    }

    // The Moon, its lit side turned towards the Sun
    const { moon } = scene;
    const moonXY = moon.alt > -1 && project(moon.alt, moon.az);
    if (moonXY) {
        const [x, y] = moonXY;
        const [sx, sy] = project(moon.towards.alt, moon.towards.az) || [x + 1, y];
        const angle = Math.atan2(sy - y, sx - x) / SKY_DEG;
        const r = 15, k = moon.illumination, tr = r * Math.abs(1 - 2 * k);
        // Moonlight: a wide glow, stronger the fuller it is and the darker the sky
        const moonGlow = k * (scene.sunAlt < -6 ? 0.5 : 0.2);
        parts.push(`<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r * 5}" fill="url(#sky-moon-glow)" opacity="${moonGlow.toFixed(2)}"/>
            <circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r}" fill="#3b4459"/>
            <path d="M0,${-r} A${r},${r} 0 0 1 0,${r} A${fmt(tr)},${r} 0 0 ${k > 0.5 ? 1 : 0} 0,${-r}Z" fill="#f1f5f9"
                transform="translate(${fmt(x)},${fmt(y)}) rotate(${fmt(angle)})"/>`);
        labels.push({ x, y, r, text: 'Moon', cls: 'sky-planet-name', size: 19, priority: 0 });
    }

    // The Sun, when it's up, in a bright halo
    const sunXY = scene.sun.alt > -1 && project(scene.sun.alt, scene.sun.az);
    if (sunXY) {
        parts.push(`<circle cx="${fmt(sunXY[0])}" cy="${fmt(sunXY[1])}" r="150" fill="url(#sky-sun-halo)" opacity="${scene.halo.toFixed(2)}"/>
            <circle cx="${fmt(sunXY[0])}" cy="${fmt(sunXY[1])}" r="16" fill="#fff3c4"/>`);
    }

    // The ground covers everything below the horizon, with the compass points marked along its edge.
    // The horizon is followed round until it's well out of the picture at both sides, then closed
    // far below, so the ground's outline never cuts across the picture.
    const edge = [];
    for (let dA = -178; dA <= 178; dA += 2) {
        const xy = project.unbounded(0, facing + dA);
        if (xy) edge.push(xy);
    }
    const far = 20 * SKY_H;
    const groundPath = `M${edge.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join('L')}`
        + `L${fmt(edge[edge.length - 1][0] + far)},${far}L${fmt(edge[0][0] - far)},${far}Z`;
    frame.push(`<path d="${groundPath}" fill="url(#sky-ground)" class="sky-ground"/>`);
    for (let i = 0; i < 16; i++) {
        const xy = project(0, i * 22.5);
        if (!xy || xy[0] < -40 || xy[0] > w + 40) continue;
        const main = i % 4 === 0;
        frame.push(`<line x1="${fmt(xy[0])}" y1="${fmt(xy[1])}" x2="${fmt(xy[0])}" y2="${fmt(xy[1] + (main ? 10 : 6))}" class="sky-tick"/>
            <text x="${fmt(xy[0])}" y="${fmt(xy[1] + (main ? 28 : 22))}" class="sky-compass${main ? '' : ' minor'}">${SKY_COMPASS[i]}</text>`);
    }
    // The warm glow on the horizon below the Sun, when it's near enough to be in view
    let glow = '';
    const glowXY = scene.glow > 0.02 && project(Math.max(scene.sun.alt, 1), scene.sun.az);
    if (glowXY) {
        glow = `<ellipse cx="${fmt(glowXY[0])}" cy="${fmt(Math.max(glowXY[1], SKY_HORIZON_AT * SKY_H - 40))}" rx="${fmt(w * 0.55)}" ry="${fmt(SKY_H * 0.55)}"
            fill="url(#sky-sunset-glow)" opacity="${scene.glow.toFixed(2)}"/>`;
    }
    const { top, horizon } = scene.colours;
    const groundTop = skyMix(horizon, [8, 10, 14], 0.82), groundBottom = skyMix(horizon, [2, 3, 5], 0.95);
    return `<defs>
            <linearGradient id="sky-dome" gradientUnits="userSpaceOnUse" x1="0" y1="${SKY_ZENITH_AT * SKY_H}" x2="0" y2="${SKY_HORIZON_AT * SKY_H}">
                <stop offset="0" stop-color="${skyCss(top)}"/><stop offset="0.6" stop-color="${skyCss(skyMix(top, horizon, 0.35))}"/>
                <stop offset="1" stop-color="${skyCss(horizon)}"/></linearGradient>
            <linearGradient id="sky-ground" gradientUnits="userSpaceOnUse" x1="0" y1="${SKY_H * 0.5}" x2="0" y2="${SKY_H}">
                <stop offset="0" stop-color="${skyCss(groundTop)}"/><stop offset="0.8" stop-color="${skyCss(groundBottom)}"/></linearGradient>
            <radialGradient id="sky-sunset-glow"><stop offset="0" stop-color="#ffb070" stop-opacity="0.75"/>
                <stop offset="0.45" stop-color="#ff8a5c" stop-opacity="0.25"/><stop offset="1" stop-color="#ff8a5c" stop-opacity="0"/></radialGradient>
            <radialGradient id="sky-sun-halo"><stop offset="0" stop-color="#fffbe8" stop-opacity="0.9"/>
                <stop offset="0.25" stop-color="#fff1c2" stop-opacity="0.35"/><stop offset="1" stop-color="#fff1c2" stop-opacity="0"/></radialGradient>
            <radialGradient id="sky-star-glow"><stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/>
                <stop offset="0.2" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="0.5" stop-color="#e6eeff" stop-opacity="0.1"/>
                <stop offset="1" stop-color="#e6eeff" stop-opacity="0"/></radialGradient>
            <radialGradient id="sky-moon-glow"><stop offset="0" stop-color="#f1f5f9" stop-opacity="0.55"/>
                <stop offset="0.4" stop-color="#cbd5e1" stop-opacity="0.15"/><stop offset="1" stop-color="#cbd5e1" stop-opacity="0"/></radialGradient>
        </defs>
        <rect x="-200" y="-200" width="${w + 400}" height="${SKY_H + 400}" fill="url(#sky-dome)"/>
        ${glow}
        <g class="${scene.light ? 'sky-light' : ''}" style="--sky-fade:${scene.figureFade.toFixed(2)};--sky-label-fade:${scene.labelFade.toFixed(2)}">${parts.join('')}</g>
        ${frame.join('')}
        <g style="--sky-label-fade:${scene.labelFade.toFixed(2)}">${skyPlaceLabels(labels).join('')}</g>`; // over the ground, so none are hidden by it
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

// --- The slideshow's sky slide. Looking one way it's drawn once a minute; turning, the picture is
// drawn afresh a few times a second from the scene worked out each minute.

const SKY_TURN_MS = 3 * 60000; // once round the horizon, when it's turning (the sky's Turn button)
const SKY_FRAME_MS = 50;       // turning: at most 20 pictures a second (gentle on a Raspberry Pi)

let skySlide = null; // { el, timer, frame }

// sky: the slideshowSky setting { mode, facing, afterSunsetMinutes, lat, lon }
function skySlideAvailable(sky) {
    return !!sky && sky.lat != null && sky.lon != null;
}

function showSkySlide(sky) {
    const el = document.getElementById('screensaver-sky');
    if (!el) return;
    hideSkySlide(true);
    el.hidden = false;
    // As wide as the space it fills
    const w = SKY_H * (el.clientWidth / el.clientHeight || 16 / 9);
    el.innerHTML = `<svg viewBox="0 0 ${w.toFixed(1)} ${SKY_H}" class="sky-svg" role="img" aria-label="The sky"></svg>`;
    const svg = el.firstElementChild;
    const slide = skySlide = { el, timer: null, frame: 0, listening: new AbortController() };
    let scene = skyScene(Date.now(), sky);
    let facing = sky.facing; // where it's looking now
    const draw = () => { svg.innerHTML = skyLensSvg(scene, facing, w); };
    slide.timer = setInterval(() => { scene = skyScene(Date.now(), sky); draw(); }, 60000);

    // Turning slowly: from where it's looking, carrying on round from wherever a drag leaves it.
    // Started and stopped with the sky's Turn button, which is remembered for next time.
    let turnFrom = facing, turnStart = 0, dragging = null; // { x, facing, degPerPx }
    let last = -Infinity;
    const tick = now => {
        if (skySlide !== slide || !slide.turning) return;
        if (!dragging && now - last >= SKY_FRAME_MS) {
            last = now;
            facing = skyNorm(turnFrom + (now - turnStart) / SKY_TURN_MS * 360);
            draw();
        }
        slide.frame = requestAnimationFrame(tick);
    };
    slide.setTurning = on => {
        slide.turning = on;
        cancelAnimationFrame(slide.frame);
        if (on) {
            turnFrom = facing;
            turnStart = performance.now();
            slide.frame = requestAnimationFrame(tick);
        }
        document.getElementById('ss-sky-turn')?.classList.toggle('is-on', on);
    };
    let turning = sky.mode === 'turning'; // as the settings once chose, until the button is used
    try { const saved = localStorage.getItem('skyTurning'); if (saved !== null) turning = saved === '1'; } catch { }
    slide.setTurning(turning);
    draw();

    // Dragging left or right turns the view, the sky following the finger
    const { signal } = slide.listening;
    let pending = 0;
    el.addEventListener('pointerdown', e => {
        // How many degrees one screen pixel is, near the middle of the view
        const project = skyLensProject(facing, w);
        const unitsPerDeg = (project(0, facing + 10)?.[0] - w / 2) / 10 || 1;
        dragging = { x: e.clientX, facing, degPerPx: w / el.clientWidth / unitsPerDeg };
        el.setPointerCapture(e.pointerId);
        el.classList.add('dragging');
    }, { signal });
    el.addEventListener('pointermove', e => {
        if (!dragging) return;
        facing = skyNorm(dragging.facing - (e.clientX - dragging.x) * dragging.degPerPx);
        if (!pending) pending = requestAnimationFrame(() => { pending = 0; draw(); });
    }, { signal });
    const endDrag = () => {
        if (!dragging) return;
        dragging = null;
        el.classList.remove('dragging');
        turnFrom = facing;
        turnStart = performance.now();
    };
    el.addEventListener('pointerup', endDrag, { signal });
    el.addEventListener('pointercancel', endDrag, { signal });
    void el.offsetWidth; // so it fades in
    el.classList.add('showing');
}

// The sky's Turn button: starts or stops it turning, and remembers which for next time
function toggleSkyTurning() {
    if (!skySlide) return;
    skySlide.setTurning(!skySlide.turning);
    try { localStorage.setItem('skyTurning', skySlide.turning ? '1' : '0'); } catch { }
}

// Fades the sky slide out (at once with `now`)
function hideSkySlide(now = false) {
    if (!skySlide) return;
    const { el, timer, frame, listening } = skySlide;
    skySlide = null;
    clearInterval(timer);
    cancelAnimationFrame(frame);
    listening.abort();
    el.classList.remove('dragging');
    el.classList.remove('showing');
    const done = () => {
        if (skySlide) return; // shown again meanwhile
        el.hidden = true;
        el.innerHTML = '';
    };
    if (now) done(); else setTimeout(done, 1000);
}

// Slideshow settings: fills in this device's location, then saves it
function useDeviceSkyLocation() {
    if (!navigator.geolocation) return showToast('This browser can\'t share its location', 'error');
    navigator.geolocation.getCurrentPosition(pos => {
        document.getElementById('slideshow-sky-lat-input').value = pos.coords.latitude.toFixed(4);
        document.getElementById('slideshow-sky-lon-input').value = pos.coords.longitude.toFixed(4);
        saveSlideshowSettings();
    }, err => showToast(window.isSecureContext ? `Couldn't get the location: ${err.message}` : 'The browser only shares its location over HTTPS. Type it in instead', 'error'),
    { timeout: 15000 });
}
