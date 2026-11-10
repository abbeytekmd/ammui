// Tag Faces: finds the faces in a library folder's photos, recognises the people it has been
// taught, and tags each photo with the names of the people in it.
//
// The finding and recognising happens here in the browser (face-api, loaded from a CDN the first
// time it's used); only each face's descriptor - 128 numbers, close together for faces of the same
// person - goes to the server, which keeps the people it has been taught and caches each photo's
// faces so a folder is only scanned once (until its photos change).

const FACE_API_BASE = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/';
const FACE_MIN_CONFIDENCE = 0.5;
const FACE_MIN_SIZE = 0.03;          // faces smaller than this share of the photo give poor descriptors
const FACE_CLUSTER_DISTANCE = 0.45;  // unknown faces this close are grouped as one person
const FACE_MATCH_MARGIN = 0.04;      // a match must be this much nearer than the next person
const FACE_SUPPORT_BAND = 0.1;       // ...and, once they have 3+ samples, a second must be within the threshold plus this
const FACE_MAYBE_BAND = 0.08;        // faces up to this far past the threshold are shown as maybes
const FACE_LEARN_PER_PERSON = 8;     // most faces each person learns from each time photos are tagged
const FACE_LEARN_MIN_NEW = 0.2;      // a face must be at least this unlike what's known to be worth learning
const FACE_LEARN_CONFIDENT = 0.9;    // automatic matches are learned from only within this share of the threshold
const FACE_TILES_PER_GROUP = 60;
const FACE_GROUPS_SHOWN = 40;
const FACE_SAVE_BATCH = 10;

let _faceApiPromise = null;
let _faceTag = null;

function loadFaceApi() {
    if (!_faceApiPromise) {
        _faceApiPromise = (async () => {
            const mod = await import(FACE_API_BASE + 'dist/face-api.esm.js');
            const faceapi = mod.nets ? mod : mod.default;
            await faceapi.tf.ready();
            const models = FACE_API_BASE + 'model';
            await Promise.all([
                faceapi.nets.ssdMobilenetv1.loadFromUri(models),
                faceapi.nets.faceLandmark68Net.loadFromUri(models),
                faceapi.nets.faceRecognitionNet.loadFromUri(models),
            ]);
            return faceapi;
        })().catch(err => { _faceApiPromise = null; throw err; });
    }
    return _faceApiPromise;
}

// The same picture is scanned and cropped for the face tiles, so the tiles come from the browser's cache.
function facePhotoUrl(relPath) {
    const uri = '/local-files/' + relPath.split('/').map(encodeURIComponent).join('/');
    return `/api/thumb?uri=${encodeURIComponent(uri)}&w=1024`;
}

function faceDistance(a, b) {
    let sum = 0;
    for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; sum += d * d; }
    return Math.sqrt(sum);
}

// The distance if it's under `limit`, else Infinity (giving up as soon as it's past it, which is
// most pairs of faces, so comparing every face in a big folder with every other stays quick).
function faceDistanceWithin(a, b, limit) {
    const lim2 = limit * limit;
    let sum = 0;
    for (let i = 0; i < 128; i++) {
        const d = a[i] - b[i];
        sum += d * d;
        if (sum >= lim2) return Infinity;
    }
    return Math.sqrt(sum);
}

function faceTagThreshold() {
    try { const v = parseFloat(localStorage.getItem('faceTagThreshold')); if (v >= 0.4 && v <= 0.6) return v; } catch (e) { }
    return 0.5;
}

async function openFaceTagModal(index, event) {
    if (event) event.stopPropagation();
    document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));
    const item = currentBrowserItems[index];
    if (!item) return;

    _faceTag = {
        item, photos: [], people: [], samples: [], faces: [], clusters: [],
        threshold: faceTagThreshold(), scanning: false, stop: false, failed: 0, renderTimer: null,
    };
    document.getElementById('face-tag-desc').textContent = `Photos in "${item.title}" and the folders inside it.`;
    const slider = document.getElementById('face-tag-threshold');
    slider.value = _faceTag.threshold;
    updateFaceTagThresholdLabel();
    document.getElementById('face-tag-results').innerHTML = '';
    document.getElementById('face-tag-people').innerHTML = '';
    document.getElementById('face-tag-modal').style.display = 'flex';
    setFaceTagStatus('Finding photos...', 0);
    updateFaceTagButtons();

    const state = _faceTag;
    try {
        const [photosRes] = await Promise.all([
            fetch(`/api/local/face-photos?id=${encodeURIComponent(item.id)}`).then(async r => {
                const data = await r.json();
                if (!r.ok) throw new Error(data.error || r.statusText);
                return data;
            }),
            loadFacePeople(),
        ]);
        if (state !== _faceTag) return;
        state.photos = photosRes.photos;
        state.photos.forEach((p, i) => (p.faces || []).forEach(f => addFace(i, f, false)));
        rematchFaces();
        if (!state.photos.length) return setFaceTagStatus('No photos in this folder.', 0);
        scanFaces();
    } catch (err) {
        if (state === _faceTag) setFaceTagStatus(`Couldn't read the folder: ${err.message}`, 0, true);
    }
}

function closeFaceTagModal() {
    if (_faceTag) {
        _faceTag.stop = true;
        clearTimeout(_faceTag.renderTimer);
    }
    _faceTag = null;
    document.getElementById('face-tag-modal').style.display = 'none';
    document.getElementById('face-tag-results').innerHTML = '';
}

function stopFaceTagScan() {
    if (_faceTag?.scanning) _faceTag.stop = true;
}

function setFaceTagStatus(text, fraction, isError = false) {
    const status = document.getElementById('face-tag-status');
    status.textContent = text;
    status.classList.toggle('error', isError);
    document.getElementById('face-tag-bar').style.width = `${Math.round((fraction || 0) * 100)}%`;
}

async function loadFacePeople() {
    const res = await fetch('/api/faces/people');
    const data = await res.json();
    if (!_faceTag) return;
    _faceTag.people = data.people || [];
    _faceTag.samples = (data.samples || []).map(s => ({ ...s, descriptor: Float32Array.from(s.descriptor) }));
    document.getElementById('face-tag-names').innerHTML = _faceTag.people.map(p => `<option value="${escapeHtml(p.name)}"></option>`).join('');
}

// ─── Scanning ────────────────────────────────────────────────────────────────

function loadFaceImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Not an image the browser can show'));
        img.src = url;
    });
}

async function scanFaces() {
    const state = _faceTag;
    const todo = state.photos.map((p, i) => i).filter(i => !state.photos[i].faces);
    const total = state.photos.length;
    let scanned = 0;
    const done = () => total - todo.length + scanned;
    if (!todo.length) return finishFaceScan(`All ${total} photos already scanned.`);

    state.scanning = true;
    updateFaceTagButtons();
    let faceapi;
    try {
        setFaceTagStatus(_faceApiPromise ? 'Starting face recognition...' : 'Loading face recognition (about 12 MB, first time only)...', done() / total);
        faceapi = await loadFaceApi();
    } catch (err) {
        state.scanning = false;
        updateFaceTagButtons();
        if (state === _faceTag) setFaceTagStatus(`Couldn't load face recognition: ${err.message}`, 0, true);
        return;
    }

    const options = new faceapi.SsdMobilenetv1Options({ minConfidence: FACE_MIN_CONFIDENCE });
    const toSave = [];
    const save = () => {
        if (!toSave.length) return;
        const items = toSave.splice(0);
        fetch('/api/faces/scans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) })
            .catch(err => console.warn('[FACES] Caching scan results failed:', err));
    };

    // The next picture downloads while this one is being looked at.
    let next = loadFaceImage(facePhotoUrl(state.photos[todo[0]].path)).catch(e => e);
    for (let n = 0; n < todo.length; n++) {
        if (state.stop) break;
        const photo = state.photos[todo[n]];
        setFaceTagStatus(`Scanning ${done() + 1} of ${total}: ${photo.path.split('/').pop()}`, done() / total);
        const img = await next;
        if (n + 1 < todo.length) next = loadFaceImage(facePhotoUrl(state.photos[todo[n + 1]].path)).catch(e => e);
        if (img instanceof Error) { state.failed++; scanned++; continue; }

        try {
            const W = img.naturalWidth, H = img.naturalHeight;
            const found = await faceapi.detectAllFaces(img, options).withFaceLandmarks().withFaceDescriptors();
            const round = (v, dp) => +v.toFixed(dp);
            photo.faces = found
                .filter(d => Math.max(d.detection.box.width / W, d.detection.box.height / H) >= FACE_MIN_SIZE)
                .map(d => {
                    const b = d.detection.box;
                    return {
                        box: [b.x / W, b.y / H, b.width / W, b.height / H].map(v => round(v, 4)),
                        ar: round(W / H, 4),
                        descriptor: Array.from(d.descriptor, v => round(v, 5)),
                    };
                });
            if (state !== _faceTag) return;
            photo.faces.forEach(f => addFace(todo[n], f));
            toSave.push({ key: photo.key, stamp: photo.stamp, faces: photo.faces });
            if (toSave.length >= FACE_SAVE_BATCH) save();
            scheduleFaceTagRender();
        } catch (err) {
            console.warn(`[FACES] ${photo.path}:`, err);
            state.failed++;
        }
        scanned++;
    }
    save();
    state.scanning = false;
    if (state !== _faceTag) return;
    finishFaceScan(state.stop ? `Stopped after ${done()} of ${total} photos.` : `Scanned ${total} photos.`);
}

function finishFaceScan(message) {
    const state = _faceTag;
    if (!state) return;
    const faces = state.faces.length;
    const failed = state.failed ? `, ${state.failed} couldn't be read` : '';
    setFaceTagStatus(`${message} ${faces} face${faces === 1 ? '' : 's'} found${failed}.`, 1);
    updateFaceTagButtons();
    // Faces found during the scan were put in groups one at a time; now they're all in, group them properly.
    rematchFaces();
}

// ─── Matching ────────────────────────────────────────────────────────────────
// A face is compared with each person on their nearest samples. It's theirs when it's within the
// threshold, no one else comes close, and (once they've 3 or more samples) a second of their samples
// agrees, so one stray sample can't carry it. If it's nearly that, it's a maybe, for a yes or no.

// { match: { name, dist, sampleId } | null, maybe: { name, dist } | null }. Names the face has been
// taken off (face.rejected) are left out.
function matchFace(face) {
    const per = new Map();   // name -> { name, d1, d2, n, sampleId }: their nearest two samples
    for (const s of _faceTag.samples) {
        if (face.rejected.has(s.name)) continue;
        let p = per.get(s.name);
        if (!p) per.set(s.name, p = { name: s.name, d1: Infinity, d2: Infinity, n: 0, sampleId: null });
        p.n++;
        const dist = faceDistance(face.descriptor, s.descriptor);
        if (dist < p.d1) { p.d2 = p.d1; p.d1 = dist; p.sampleId = s.id; }
        else if (dist < p.d2) p.d2 = dist;
    }
    let best = null, next = null;
    for (const p of per.values()) {
        if (!best || p.d1 < best.d1) { next = best; best = p; }
        else if (!next || p.d1 < next.d1) next = p;
    }
    const T = _faceTag.threshold;
    if (!best || best.d1 >= T + FACE_MAYBE_BAND) return { match: null, maybe: null };
    const supported = best.n < 3 || best.d2 < T + FACE_SUPPORT_BAND;
    const clear = !next || next.d1 - best.d1 >= FACE_MATCH_MARGIN;
    if (best.d1 < T && supported && clear) return { match: { name: best.name, dist: best.d1, sampleId: best.sampleId }, maybe: null };
    return { match: null, maybe: { name: best.name, dist: best.d1 } };
}

// `place`: match and group it now (while scanning); opening a folder groups its faces all at once after.
function addFace(photoIndex, raw, place = true) {
    // named: who it was dragged to, confirmed as or named as. rejected: people it was taken off. pin:
    // the group it was dragged into (groups are rebuilt on every rematch, so it's kept as a token).
    // sampleId: the sample it taught, taken back if it's taken off that person again.
    // unmatched: double-clicked off the person it matched, so it's left with the unknown faces.
    // neighbors: [face, distance] for every face close enough to be grouped with it.
    const face = {
        index: _faceTag.faces.length, photoIndex, box: raw.box, ar: raw.ar, descriptor: Float32Array.from(raw.descriptor),
        off: false, named: null, rejected: new Set(), pin: null, sampleId: null, unmatched: false,
        match: null, maybe: null, cluster: null, neighbors: [],
    };
    for (const other of _faceTag.faces) {
        const dist = faceDistanceWithin(face.descriptor, other.descriptor, FACE_CLUSTER_DISTANCE);
        if (dist === Infinity) continue;
        face.neighbors.push([other, dist]);
        other.neighbors.push([face, dist]);
    }
    _faceTag.faces.push(face);
    if (place) assignFace(face);
}

// Who a face is: who it was named as, else who it matches (or might).
function placeFace(face) {
    face.cluster = null;
    if (face.named) {
        face.match = { name: face.named, dist: 0 };
        face.maybe = null;
    } else if (face.pin || face.unmatched) {
        // Dragged into a group, or double-clicked off a person: it stays unknown
        face.match = face.maybe = null;
    } else {
        ({ match: face.match, maybe: face.maybe } = matchFace(face));
    }
}

// A face found while scanning: matched, or put with the unknown group most like it for now
// (the groups are worked out properly when the scan ends).
function assignFace(face) {
    placeFace(face);
    if (face.match || face.maybe) return;
    let best = null, bestDist = FACE_CLUSTER_DISTANCE;
    if (face.pin) best = _faceTag.clusters.find(c => c.pin === face.pin) || null;
    else {
        for (const c of _faceTag.clusters) {
            if (!c.faces.length || c.pin?.startsWith('solo')) continue;   // dragged out on its own: keeps to itself
            const dist = faceDistance(face.descriptor, c.centroid);
            if (dist < bestDist) { best = c; bestDist = dist; }
        }
    }
    if (!best) {
        best = { id: _faceTag.clusters.length, faces: [], centroid: new Float32Array(128), pin: face.pin };
        _faceTag.clusters.push(best);
    }
    attachFace(face, best);
}

function rematchFaces() {
    _faceTag.faces.forEach(placeFace);
    groupUnknownFaces();
    renderFaceTag();
}

// Groups the faces no one is known for, by "Chinese whispers" (how dlib, whose face model this is,
// groups faces): each face starts in a group of its own; then, round after round, each joins the
// group most of its close neighbours are in, nearer ones counting for more, until none move. A
// person's faces end up together even when only some of them are alike. A face dragged into a
// group keeps it (and others can join it), and one dragged out on its own stays alone.
function groupUnknownFaces() {
    const state = _faceTag;
    const unknown = state.faces.filter(f => !f.match && !f.maybe);
    const label = new Map(unknown.map(f => [f, f.pin || `f${f.index}`]));
    // The same order every time, so the groups don't shuffle between rematches
    let seed = 12345;
    const order = unknown.filter(f => !f.pin)
        .map(f => [f, (seed = (seed * 16807) % 2147483647)])
        .sort((a, b) => a[1] - b[1]).map(([f]) => f);
    for (let round = 0; round < 30; round++) {
        let moved = 0;
        for (const f of order) {
            const votes = new Map();
            for (const [other, dist] of f.neighbors) {
                const l = label.get(other);
                if (l === undefined || l.startsWith('solo')) continue;
                votes.set(l, (votes.get(l) || 0) + (1 - dist));
            }
            let best = label.get(f), bestVote = 0;
            for (const [l, v] of votes) if (v > bestVote) { best = l; bestVote = v; }
            if (best !== label.get(f)) { label.set(f, best); moved++; }
        }
        if (!moved) break;
    }

    const groups = new Map();
    for (const f of unknown) {
        const l = label.get(f);
        if (!groups.has(l)) groups.set(l, []);
        groups.get(l).push(f);
    }
    state.clusters = [...groups].sort((a, b) => b[1].length - a[1].length).map(([l, faces], id) => {
        const cluster = { id, faces: [], centroid: new Float32Array(128), pin: /^(pin|solo)/.test(l) ? l : null };
        faces.forEach(f => attachFace(f, cluster));
        return cluster;
    });
}

function setFaceTagThreshold(value) {
    if (!_faceTag) return;
    _faceTag.threshold = parseFloat(value);
    try { localStorage.setItem('faceTagThreshold', value); } catch (e) { }
    updateFaceTagThresholdLabel();
    clearTimeout(_faceTag.rematchTimer);
    _faceTag.rematchTimer = setTimeout(rematchFaces, 150);
}

function updateFaceTagThresholdLabel() {
    const v = parseFloat(document.getElementById('face-tag-threshold').value);
    document.getElementById('face-tag-threshold-label').textContent = v <= 0.45 ? 'Strict' : v >= 0.55 ? 'Loose' : 'Balanced';
}

// ─── Teaching ────────────────────────────────────────────────────────────────

// Up to `max` faces spread through the list, so a person is learned from several photos.
function spreadFaces(faces, max) {
    if (faces.length <= max) return faces;
    return Array.from({ length: max }, (_, i) => faces[Math.floor(i * faces.length / max)]);
}

async function teachFaces(name, faces, { quiet = false } = {}) {
    name = String(name || '').trim();
    if (!name || !faces.length || !_faceTag) return;
    const state = _faceTag;
    try {
        const taught = spreadFaces(faces, 20);
        const samples = taught.map(f => ({ descriptor: Array.from(f.descriptor), source: state.photos[f.photoIndex].key }));
        const res = await fetch('/api/faces/people', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, samples }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        if (state !== _faceTag) return;
        faces.forEach(f => { f.named = data.person.name; f.off = false; f.pin = null; f.unmatched = false; f.rejected.delete(data.person.name); });
        taught.forEach((f, i) => { f.sampleId = data.sampleIds?.[i] ?? null; });
        await loadFacePeople();
        rematchFaces();
        if (!quiet) showToast(`Learned ${data.person.name} from ${samples.length} face${samples.length === 1 ? '' : 's'}`, 'success', 2500);
    } catch (err) {
        showToast(`Couldn't save ${name}: ${err.message}`, 'error', 5000);
    }
}

function nameFaceCluster(clusterId) {
    const cluster = _faceTag?.clusters[clusterId];
    const input = document.getElementById(`face-cluster-name-${clusterId}`);
    if (!cluster || !input) return;
    if (!input.value.trim()) return input.focus();
    teachFaces(input.value, cluster.faces.filter(f => !f.off));
}

async function forgetFacePerson(id) {
    const person = _faceTag?.people.find(p => p.id === id);
    if (!person || !confirm(`Forget ${person.name}? Photos already tagged keep their tags.`)) return;
    try {
        const res = await fetch(`/api/faces/people/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
        _faceTag.faces.forEach(f => { if (f.named === person.name) f.named = null; });
        await loadFacePeople();
        rematchFaces();
    } catch (err) {
        showToast(`Couldn't forget ${person.name}: ${err.message}`, 'error', 5000);
    }
}

// A click waits to see if it's the start of a double-click, which does something else.
let _faceClickTimer = null;

function faceTileClick(faceIndex) {
    clearTimeout(_faceClickTimer);
    _faceClickTimer = setTimeout(() => clickFaceTile(faceIndex), 250);
}

function faceTileDblClick(faceIndex) {
    clearTimeout(_faceClickTimer);
    unmatchFace(faceIndex);
}

// Double-click on a recognised face, or a maybe: it isn't them. Only that face moves, into the
// unknown group most like it (or on its own), and it isn't matched to anyone again.
async function unmatchFace(faceIndex) {
    const state = _faceTag;
    const face = state?.faces[faceIndex];
    if (!face?.match && !face?.maybe) return;
    if (face.maybe) face.rejected.add(face.maybe.name);
    keepFaceFollowers(face);
    await forgetFaceAsPerson(face);
    if (state !== _faceTag) return;
    detachFace(face);
    face.unmatched = true;
    face.pin = null;
    face.off = false;
    let best = null, bestDist = FACE_CLUSTER_DISTANCE;
    for (const c of state.clusters) {
        if (!c.faces.length || c.pin?.startsWith('solo')) continue;
        const dist = faceDistance(face.descriptor, c.centroid);
        if (dist < bestDist) { best = c; bestDist = dist; }
    }
    if (!best) {
        best = { id: state.clusters.length, faces: [], centroid: new Float32Array(128), pin: null };
        state.clusters.push(best);
    }
    attachFace(face, best);
    renderFaceTag();
}

// A tile: on a recognised person it switches the face in or out of the tagging; on a maybe it's a
// yes; on a face no one is known for, it asks who it is.
function clickFaceTile(faceIndex) {
    const face = _faceTag?.faces[faceIndex];
    if (!face) return;
    if (face.maybe) return confirmFaceMaybes([face]);
    if (!face.match) {
        const name = prompt('Who is this?', '');
        if (name?.trim()) teachFaces(name, [face]);
        return;
    }
    face.off = !face.off;
    document.querySelector(`.face-tile[data-face="${faceIndex}"]`)?.classList.toggle('off', face.off);
    updateFaceTagButtons();
}

// A maybe is them: each face moves up to the person, and nothing else changes.
function confirmFaceMaybes(faces) {
    for (const face of faces) {
        if (!face.maybe) continue;
        const name = face.maybe.name;
        detachFace(face);
        face.named = name;
        face.off = false;
        face.match = { name, dist: 0 };
    }
    renderFaceTag();
}

function confirmFaceMaybesFor(name) {
    confirmFaceMaybes((_faceTag?.faces || []).filter(f => f.maybe?.name === name && !f.off));
}

// ─── Keeping other faces where they are ──────────────────────────────────────
// Moving a face only ever moves that face. If it was one of the faces a group was named from, what
// it taught its person is taken back (so it doesn't spoil future scans), and the faces matched
// through that are fixed to the person they're shown with, so they don't move now or on a rematch.
function keepFaceFollowers(face) {
    if (!_faceTag || !face?.match || !face.sampleId) return;
    for (const f of _faceTag.faces) {
        if (f !== face && !f.named && !f.pin && !f.unmatched && f.match?.sampleId === face.sampleId) f.named = f.match.name;
    }
}

// ─── Dragging faces between groups ───────────────────────────────────────────
// Only the face dragged moves: nothing is re-matched and no one is taught from it, so no other
// face changes group.
// Onto a person (their group or their name at the top): it's them.
// Onto an unrecognised group: it's whoever that is, and not the person it came from.
// Onto the faces seen only once: it's no one known, on its own.

let _facePinCount = 0;

function faceDragStart(event, faceIndex) {
    if (!_faceTag) return;
    _faceTag.dragging = faceIndex;
    event.dataTransfer.setData('text/plain', String(faceIndex));
    event.dataTransfer.effectAllowed = 'move';
    event.currentTarget.classList.add('dragging');
    document.getElementById('face-tag-modal').classList.add('face-dragging');
}

function faceDragEnd(event) {
    event.currentTarget.classList.remove('dragging');
    document.getElementById('face-tag-modal').classList.remove('face-dragging');
    document.querySelectorAll('#face-tag-modal .drop-target').forEach(el => el.classList.remove('drop-target'));
    if (!_faceTag) return;
    _faceTag.dragging = null;
    if (_faceTag.renderPending) renderFaceTag();
}

// The face being dragged, if dropping it on `el` would move it.
function faceDropAllowed(el) {
    const face = _faceTag?.faces[_faceTag.dragging];
    if (!face) return null;
    const d = el.dataset;
    if (d.dropPerson != null) return face.match?.name === d.dropPerson ? null : face;
    if (d.dropCluster != null) return face.cluster?.id === Number(d.dropCluster) ? null : face;
    if (d.dropSingles != null) return face.cluster?.faces.length === 1 ? null : face;
    return null;
}

function faceDragOver(event) {
    const el = event.currentTarget;
    const face = faceDropAllowed(el);
    if (!face) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target');
}

function faceDragLeave(event) {
    const el = event.currentTarget;
    if (el.contains(event.relatedTarget)) return;
    el.classList.remove('drop-target');
}

async function faceDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    const el = event.currentTarget;
    el.classList.remove('drop-target');
    const face = faceDropAllowed(el);
    if (!face) return;
    const d = el.dataset;
    // The drag is over as far as rendering goes: the tile may be gone before its dragend arrives.
    _faceTag.dragging = null;
    document.getElementById('face-tag-modal').classList.remove('face-dragging');
    const state = _faceTag;
    if (face.maybe && face.maybe.name !== d.dropPerson) face.rejected.add(face.maybe.name);
    keepFaceFollowers(face);
    if (d.dropPerson == null || face.match) await forgetFaceAsPerson(face);
    if (state !== _faceTag) return;
    // Groups are found again on a rematch, but not now: re-forming them could move other faces.
    const cluster = d.dropCluster != null ? state.clusters[Number(d.dropCluster)] : null;
    if (d.dropCluster != null && !cluster) return;
    detachFace(face);
    face.off = false;
    face.unmatched = false;
    if (d.dropPerson != null) {
        face.named = d.dropPerson;
        face.rejected.delete(d.dropPerson);
        face.pin = null;
        face.match = { name: d.dropPerson, dist: 0 };
    } else if (cluster) {
        cluster.pin ||= `pin${++_facePinCount}`;
        face.pin = cluster.pin;
        attachFace(face, cluster);
    } else {
        face.pin = `solo${++_facePinCount}`;
        const solo = { id: state.clusters.length, faces: [], centroid: new Float32Array(128), pin: face.pin };
        state.clusters.push(solo);
        attachFace(face, solo);
    }
    renderFaceTag();
}

// Takes a face out of the person or group it's in, without disturbing the rest.
function detachFace(face) {
    face.match = null;
    face.maybe = null;
    const cluster = face.cluster;
    face.cluster = null;
    if (!cluster) return;
    cluster.faces = cluster.faces.filter(f => f !== face);
    cluster.centroid = new Float32Array(128);
    cluster.faces.forEach(f => { for (let i = 0; i < 128; i++) cluster.centroid[i] += f.descriptor[i] / cluster.faces.length; });
}

function attachFace(face, cluster) {
    face.match = null;
    face.maybe = null;
    face.off = false;   // there's no leaving out among the unknown faces (a click there names it)
    face.cluster = cluster;
    cluster.faces.push(face);
    const n = cluster.faces.length;
    for (let i = 0; i < 128; i++) cluster.centroid[i] += (face.descriptor[i] - cluster.centroid[i]) / n;
}

// The face isn't the person it's matched to: it won't be matched to them again, and if it
// taught them, that's taken back.
async function forgetFaceAsPerson(face) {
    if (!face.match) return;
    face.rejected.add(face.match.name);
    face.named = null;
    if (face.sampleId) {
        const id = face.sampleId;
        face.sampleId = null;
        try {
            await fetch(`/api/faces/samples/${id}`, { method: 'DELETE' });
            await loadFacePeople();
        } catch (err) {
            console.warn('[FACES] Taking back a sample failed:', err);
        }
    }
}

// ─── Showing ─────────────────────────────────────────────────────────────────

function scheduleFaceTagRender() {
    if (!_faceTag || _faceTag.renderTimer) return;
    if (_faceTag.dragging != null) { _faceTag.renderPending = true; return; }
    _faceTag.renderTimer = setTimeout(() => {
        if (!_faceTag) return;
        _faceTag.renderTimer = null;
        renderFaceTag();
    }, 1000);
}

// The face, cropped square with a margin, out of the photo as a background.
function faceTileStyle(face, photo) {
    const T = 72;
    const [x, y, w, h] = face.box;
    const s = Math.max(w * face.ar, h) * 1.5;   // side, as a share of the photo's height
    const sx = s / face.ar, sy = s;
    const cx = x + w / 2, cy = y + h / 2;
    const bw = T / sx, bh = T / sy;
    return `background-image:url('${facePhotoUrl(photo.path).replace(/'/g, '%27')}');` +
        `background-size:${bw.toFixed(1)}px ${bh.toFixed(1)}px;` +
        `background-position:${(-(cx - sx / 2) * bw).toFixed(1)}px ${(-(cy - sy / 2) * bh).toFixed(1)}px;`;
}

function faceTilesHtml(faces) {
    const state = _faceTag;
    const shown = faces.slice(0, FACE_TILES_PER_GROUP).map(f => {
        const i = f.index;
        const photo = state.photos[f.photoIndex];
        const close = f.match && !f.named ? f.match : f.maybe;
        const title = photo.path + (close ? ` (${Math.round((1 - close.dist) * 100)}% match${f.maybe ? '?' : ''})` : '');
        return `<div class="face-tile${f.off ? ' off' : ''}${f.maybe ? ' maybe' : ''}" role="button" tabindex="0" data-face="${i}" title="${escapeHtml(title)}" style="${faceTileStyle(f, photo)}"` +
            ` draggable="true" ondragstart="faceDragStart(event, ${i})" ondragend="faceDragEnd(event)"` +
            ` onclick="faceTileClick(${i})" ondblclick="faceTileDblClick(${i})"` +
            ` onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();clickFaceTile(${i})}"></div>`;
    }).join('');
    const more = faces.length - FACE_TILES_PER_GROUP;
    return `<div class="face-tiles">${shown}${more > 0 ? `<span class="face-more">+${more} more</span>` : ''}</div>`;
}

function renderFaceTag() {
    const state = _faceTag;
    if (!state) return;
    // Replacing the tiles mid-drag would lose the face being dragged; it's done when the drag ends.
    if (state.dragging != null) { state.renderPending = true; return; }
    state.renderPending = false;

    document.getElementById('face-tag-people').innerHTML = state.people.length
        ? `<span class="face-tag-label">Knows</span>` + state.people.map(p =>
            `<span class="face-person-chip" data-drop-person="${escapeHtml(p.name)}" ondragover="faceDragOver(event)" ondragleave="faceDragLeave(event)" ondrop="faceDrop(event)" title="Learned from ${p.samples} face${p.samples === 1 ? '' : 's'}. Drop a face here if it's them.">${escapeHtml(p.name)}` +
            `<button onclick="forgetFacePerson(${p.id})" title="Forget ${escapeHtml(p.name)}" aria-label="Forget ${escapeHtml(p.name)}">&times;</button></span>`).join('')
        : `<span class="face-tag-label">No one named yet. Name the groups of faces below to teach it who's who.</span>`;

    const byPerson = new Map();
    for (const f of state.faces) {
        if (!f.match) continue;
        if (!byPerson.has(f.match.name)) byPerson.set(f.match.name, []);
        byPerson.get(f.match.name).push(f);
    }
    const photosOf = faces => new Set(faces.map(f => f.photoIndex)).size;
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

    let html = '';
    if (byPerson.size) {
        html += `<h3 class="face-section-title">Recognised <span>click a face to leave it out, drag it to who it really is, or double-click if it isn't them</span></h3>`;
        for (const [name, faces] of [...byPerson].sort((a, b) => a[0].localeCompare(b[0]))) {
            html += `<div class="face-group" data-drop-person="${escapeHtml(name)}" ondragover="faceDragOver(event)" ondragleave="faceDragLeave(event)" ondrop="faceDrop(event)"><div class="face-group-head"><strong>${escapeHtml(name)}</strong>` +
                `<span>${plural(photosOf(faces), 'photo')}</span></div>${faceTilesHtml(faces)}</div>`;
        }
    }

    const maybes = new Map();
    for (const f of state.faces) {
        if (!f.maybe) continue;
        if (!maybes.has(f.maybe.name)) maybes.set(f.maybe.name, []);
        maybes.get(f.maybe.name).push(f);
    }
    if (maybes.size) {
        html += `<h3 class="face-section-title">Maybe <span>click a face if it's them, double-click if it isn't, or drag it to who it is</span></h3>`;
        for (const [name, faces] of [...maybes].sort((a, b) => a[0].localeCompare(b[0]))) {
            html += `<div class="face-group face-maybe-group" data-drop-person="${escapeHtml(name)}" ondragover="faceDragOver(event)" ondragleave="faceDragLeave(event)" ondrop="faceDrop(event)">` +
                `<div class="face-group-head"><strong>${escapeHtml(name)}?</strong>` +
                `<button class="btn-control ghost" onclick="confirmFaceMaybesFor(this.closest('[data-drop-person]').dataset.dropPerson)">Yes to All</button>` +
                `<span>${plural(photosOf(faces), 'photo')}</span></div>${faceTilesHtml(faces)}</div>`;
        }
    }

    const groups = state.clusters.filter(c => c.faces.length > 1).sort((a, b) => b.faces.length - a.faces.length);
    if (groups.length) {
        html += `<h3 class="face-section-title">Not recognised <span>name a group to teach it, click a face to name just that one, or drag it to another group</span></h3>`;
        for (const c of groups.slice(0, FACE_GROUPS_SHOWN)) {
            html += `<div class="face-group" data-drop-cluster="${c.id}" ondragover="faceDragOver(event)" ondragleave="faceDragLeave(event)" ondrop="faceDrop(event)"><div class="face-group-head">` +
                `<input type="text" id="face-cluster-name-${c.id}" list="face-tag-names" maxlength="100" placeholder="Who is this?" autocomplete="off" onkeydown="if(event.key==='Enter') nameFaceCluster(${c.id})">` +
                `<button class="btn-control ghost" onclick="nameFaceCluster(${c.id})">Save</button>` +
                `<span>${plural(photosOf(c.faces), 'photo')}</span></div>${faceTilesHtml(c.faces)}</div>`;
        }
        if (groups.length > FACE_GROUPS_SHOWN) html += `<p class="settings-hint">${groups.length - FACE_GROUPS_SHOWN} smaller groups not shown. Name some people and they'll be picked out.</p>`;
    }

    const singles = state.clusters.filter(c => c.faces.length === 1).map(c => c.faces[0]);
    if (state.faces.length) {
        html += `<details class="face-singles" data-drop-singles ondragover="faceDragOver(event)" ondragleave="faceDragLeave(event)" ondrop="faceDrop(event)"><summary>${plural(singles.length, 'face')} seen only once ` +
            `<span>click one to name it; drop a face here to take it out of its group</span></summary>${faceTilesHtml(singles)}</details>`;
    }

    // Keep what's being typed, and the open state of the singles, across a re-render.
    const results = document.getElementById('face-tag-results');
    const typed = [...results.querySelectorAll('input[id^="face-cluster-name-"]')].map(i => [i.id, i.value, i === document.activeElement]);
    const singlesOpen = results.querySelector('.face-singles')?.open;
    const scroll = results.scrollTop;
    results.innerHTML = html || (state.scanning ? '' : `<p class="settings-hint">No faces found.</p>`);
    for (const [id, value, focused] of typed) {
        const input = document.getElementById(id);
        if (!input) continue;
        input.value = value;
        if (focused) input.focus();
    }
    if (singlesOpen) results.querySelector('.face-singles')?.setAttribute('open', '');
    results.scrollTop = scroll;
    updateFaceTagButtons();
}

// photo key -> names of the people ticked in it
function faceTagsToAdd() {
    const out = new Map();
    for (const f of _faceTag?.faces || []) {
        if (!f.match || f.off) continue;
        const key = _faceTag.photos[f.photoIndex].key;
        if (!out.has(key)) out.set(key, new Set());
        out.get(key).add(f.match.name);
    }
    return out;
}

function updateFaceTagButtons() {
    const scanning = !!_faceTag?.scanning;
    document.getElementById('face-tag-stop').style.display = scanning ? '' : 'none';
    const n = _faceTag ? faceTagsToAdd().size : 0;
    const apply = document.getElementById('face-tag-apply');
    apply.disabled = !n;
    apply.textContent = n ? `Tag ${n} Photo${n === 1 ? '' : 's'}` : 'Add Tags';
}

// After tagging: each person learns from a few of the faces just accepted as them - those least like
// what it knows already (a new angle, age or light), skipping near-copies. Faces confirmed by hand
// always count; automatic matches only when they were clear ones, so an unnoticed mistake is
// unlikely to be learned. Nothing on screen is re-matched, so no face moves. Returns how many it learned.
async function learnFromAcceptedFaces() {
    const state = _faceTag;
    const byName = new Map();
    for (const f of state.faces) {
        if (!f.match || f.off || f.sampleId) continue;
        if (!f.named && f.match.dist > state.threshold * FACE_LEARN_CONFIDENT) continue;
        if (!byName.has(f.match.name)) byName.set(f.match.name, []);
        byName.get(f.match.name).push(f);
    }
    let learned = 0;
    for (const [name, faces] of byName) {
        const known = state.samples.filter(s => s.name === name).map(s => s.descriptor);
        // How unlike the nearest known face each one is; each one picked counts as known after
        const unlike = faces.map(f => known.reduce((m, k) => Math.min(m, faceDistance(f.descriptor, k)), Infinity));
        const chosen = [];
        while (chosen.length < FACE_LEARN_PER_PERSON) {
            let pick = -1;
            unlike.forEach((u, i) => { if (u >= FACE_LEARN_MIN_NEW && (pick < 0 || u > unlike[pick])) pick = i; });
            if (pick < 0) break;
            const face = faces[pick];
            chosen.push(face);
            unlike[pick] = -1;
            faces.forEach((f, i) => { if (unlike[i] > 0) unlike[i] = Math.min(unlike[i], faceDistance(f.descriptor, face.descriptor)); });
        }
        if (!chosen.length) continue;
        const res = await fetch('/api/faces/people', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, samples: chosen.map(f => ({ descriptor: Array.from(f.descriptor), source: state.photos[f.photoIndex].key })) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        chosen.forEach((f, i) => { f.sampleId = data.sampleIds?.[i] ?? null; });
        learned += (data.sampleIds || []).filter(Boolean).length;
    }
    if (learned && state === _faceTag) {
        await loadFacePeople();
        renderFaceTag();
    }
    return learned;
}

async function applyFaceTags() {
    const state = _faceTag;
    const toAdd = faceTagsToAdd();
    if (!state || !toAdd.size) return;
    const apply = document.getElementById('face-tag-apply');
    apply.disabled = true;
    try {
        const items = [...toAdd].map(([key, names]) => ({ key, add: [...names] }));
        const res = await fetch('/api/local/photo-tags', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        const names = new Set(items.flatMap(i => i.add));
        allLibraryTags = [...new Set([...allLibraryTags, ...names])].sort();
        // Photos showing in the file browser get their new tags under them
        if (typeof showBrowserTags === 'function') {
            for (const { key, add } of items) {
                const item = currentBrowserItems.find(i => i.tagKey === key);
                if (item) showBrowserTags(i => i.tagKey === key, [...new Set([...(item.tags || []), ...add])]);
            }
        }
        let learned = 0;
        try { learned = await learnFromAcceptedFaces(); }
        catch (err) { console.warn('[FACES] Learning from the tagged faces failed:', err); }
        const already = data.photos - data.changed;
        showToast(`Tagged ${data.changed} photo${data.changed === 1 ? '' : 's'} in "${state.item.title}"` +
            (already ? ` (${already} already had ${already === 1 ? 'its tags' : 'their tags'})` : '') +
            (learned ? `, and learned from ${learned} more face${learned === 1 ? '' : 's'}` : ''), 'success', 4000);
    } catch (err) {
        showToast(`Couldn't add the tags: ${err.message}`, 'error', 5000);
    } finally {
        if (state === _faceTag) updateFaceTagButtons();
    }
}
